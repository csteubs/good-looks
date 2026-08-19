// Tests for the IPC layer.
//
// `handlers/index.ts` is 721 lines and had zero coverage, which matters more
// than its size suggests: it is the app's TRUST BOUNDARY. Everything the
// renderer sends arrives here as `unknown`, and several handlers exist
// specifically to validate it — an unvalidated browser name would be handed
// straight to the Playwright CLI, an unvalidated webhook URL straight to fetch,
// unvalidated tags straight into tests.json.
//
// Handlers are captured through the stub's recording ipcMain and invoked the
// way the renderer would. Stores write into a throwaway userData dir, so this
// exercises the REAL services rather than mocks of them.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  invokeHandler,
  registeredChannels,
  setEncryptionAvailable,
} from "../services/__tests__/shell-backend-stub.js";
import { MAX_GROUP_LENGTH } from "../recorder/types.js";
import { registerHandlers } from "./index.js";
import { testStore } from "../services/test-store.js";
import { runHistoryStore } from "../services/run-history-store.js";
import { batchHistoryStore } from "../services/batch-history-store.js";
import { aiDebugStore } from "../services/ai-debug-store.js";
import { aiDebugHistoryStore } from "../services/ai-debug-history-store.js";
import { recorderDebugStore } from "../services/recorder-debug-store.js";
import { recorderSettingsStore } from "../services/recorder-settings-store.js";
import { annotationStore } from "../services/annotation-store.js";
import { healJournalStore } from "../services/heal-journal-store.js";
import { MAX_SOURCE_BYTES, scriptChangeStore } from "../services/script-change-store.js";
import { artifactStore } from "../services/artifact-store.js";
import { DELETED_TEST_NAME } from "../recorder/types.js";
import type { Step, TestRecord } from "../recorder/types.js";

// Safe to set after the imports: the stub resolves app.getPath() lazily on
// every call (deliberately, so tests can point userData at a temp dir), and
// nothing here touches disk at import time.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-handlers-test-"));
process.env.GLAZE_TEST_USERDATA = userData;

function seedTest(id: string, extra: Partial<TestRecord> = {}): TestRecord {
  const rec: TestRecord = {
    id,
    name: `Test ${id}`,
    url: "https://example.com",
    createdAt: 1,
    updatedAt: 1,
    steps: [],
    scriptPath: path.join(userData, "recorder", "scripts", `${id}.spec.ts`),
    ...extra,
  };
  testStore.save(rec);
  return rec;
}

beforeAll(() => {
  registerHandlers();
  // The webhook store refuses to save when secure storage is unavailable, which
  // the stub reports by default. Opt in so the save path is exercised — the
  // "cipher" is a marker and userData is a temp dir, so no real secret is
  // written anywhere real.
  setEncryptionAvailable(true);
});

afterAll(() => {
  setEncryptionAvailable(false);
  fs.rmSync(userData, { recursive: true, force: true });
});

describe("handler registration", () => {
  it("registers the channels the renderer's api module calls", () => {
    const channels = new Set(registeredChannels());
    // A representative slice across every feature area — a handler silently
    // failing to register shows up as "nothing happens" in the UI.
    for (const c of [
      "tests:list",
      "tests:setTags",
      "tests:deleteTag",
      "tests:setBrowser",
      "tests:setHeadless",
      "tests:setTestTimeout",
      "tests:setBaseUrl",
      "tests:duplicate",
      "runner:run",
      "runner:stop",
      "batch:run",
      "batch:stop",
      "batch:list",
      "alerts:setWebhookUrl",
      "alerts:status",
      "issues:status",
      "issues:connect",
      "issues:disconnect",
      "issues:setDefaults",
      "recorder:listCookies",
      "recorder:setCookie",
      "recorder:getSettings",
      "runs:list",
      "proxy:hasPassword",
      "proxy:verifyApp",
      "proxy:verifyTest",
    ]) {
      expect(channels.has(c), `missing channel: ${c}`).toBe(true);
    }
  });
});

describe("proxy handlers — the password's write-only contract, over real stores", () => {
  it("stores and clears the password; only presence ever crosses", async () => {
    expect(await invokeHandler("proxy:hasPassword")).toEqual({ hasPassword: false });
    expect(await invokeHandler("proxy:setPassword", { password: "s3cret" })).toEqual({
      hasPassword: true,
    });
    expect(await invokeHandler("proxy:hasPassword")).toEqual({ hasPassword: true });
    expect(await invokeHandler("proxy:clearPassword")).toEqual({ hasPassword: false });
    expect(await invokeHandler("proxy:hasPassword")).toEqual({ hasPassword: false });
  });

  it("canonicalises a proxy URL through recorder:setSettings and blanks a credentialed one", async () => {
    const saved = await invokeHandler<{ proxySource: string; proxyUrl: string }>(
      "recorder:setSettings",
      { proxySource: "manual", proxyUrl: "http://proxy.corp:8080/" },
    );
    expect(saved.proxySource).toBe("manual");
    expect(saved.proxyUrl).toBe("http://proxy.corp:8080");
    // The IPC boundary is one of the two entrances the credential-refusal rule
    // guards (the other is the file on disk) — a URL smuggling a password must
    // not survive the trip.
    const smuggled = await invokeHandler<{ proxyUrl: string }>("recorder:setSettings", {
      proxyUrl: "http://user:pw@proxy.corp:8080",
    });
    expect(smuggled.proxyUrl).toBe("");
  });
});

describe("tests:setTags — normalization at the boundary", () => {
  it("normalizes tags rather than storing them verbatim", async () => {
    seedTest("t-tags");
    const rec = await invokeHandler<TestRecord>("tests:setTags", {
      id: "t-tags",
      tags: ["  Smoke ", "smoke", "checkout", ""],
    });
    // Deduped case-insensitively (first spelling wins), trimmed, sorted.
    expect(rec.tags).toEqual(["checkout", "Smoke"]);
  });

  it("turns hostile input into an empty list instead of throwing or persisting junk", async () => {
    seedTest("t-hostile");
    for (const tags of [null, undefined, "smoke", 42, { a: 1 }]) {
      const rec = await invokeHandler<TestRecord>("tests:setTags", { id: "t-hostile", tags });
      expect(rec.tags).toEqual([]);
    }
  });

  it("drops non-string entries but keeps the valid ones", async () => {
    seedTest("t-mixed");
    const rec = await invokeHandler<TestRecord>("tests:setTags", {
      id: "t-mixed",
      tags: ["ok", 5, null, "fine"],
    });
    expect(rec.tags).toEqual(["fine", "ok"]);
  });

  it("rejects an unknown test id", async () => {
    await expect(invokeHandler("tests:setTags", { id: "nope", tags: [] })).rejects.toThrow(
      /not found/i,
    );
  });
});

describe("tests:setGroup / tests:renameGroup — the library rail's folders", () => {
  // Group names here are unique to this block: the store is shared across the
  // whole file, so a name another describe seeded would be counted too.
  it("normalizes the name rather than storing it verbatim", async () => {
    seedTest("g-norm");
    const rec = await invokeHandler<TestRecord>("tests:setGroup", {
      id: "g-norm",
      group: "  Store   front  ",
    });
    expect(rec.group).toBe("Store front");
  });

  it("UNGROUPS on anything unusable rather than erroring or storing junk", async () => {
    // The rail draws folders from the names its tests carry, so a name it
    // cannot render would be a test that vanished from the list. Ungrouped is
    // the direction that keeps every test visible.
    seedTest("g-hostile");
    for (const group of [null, undefined, "   ", 42, { a: 1 }, ["x"]]) {
      const rec = await invokeHandler<TestRecord>("tests:setGroup", { id: "g-hostile", group });
      expect(rec.group).toBeUndefined();
    }
  });

  it("DELETES the key rather than storing an empty string", async () => {
    // So "ungrouped" is one condition everywhere instead of two.
    seedTest("g-del", { group: "Gone" });
    const rec = await invokeHandler<TestRecord>("tests:setGroup", { id: "g-del", group: "" });
    expect("group" in rec).toBe(false);
  });

  it("caps a name at the store's own limit", async () => {
    seedTest("g-long");
    const rec = await invokeHandler<TestRecord>("tests:setGroup", {
      id: "g-long",
      group: "x".repeat(200),
    });
    expect(rec.group).toHaveLength(MAX_GROUP_LENGTH);
  });

  it("rejects an unknown test id", async () => {
    await expect(invokeHandler("tests:setGroup", { id: "nope", group: "X" })).rejects.toThrow(
      /not found/i,
    );
  });

  it("renames across every member in one call", async () => {
    seedTest("g-r1", { group: "Rename Me" });
    seedTest("g-r2", { group: "Rename Me" });
    seedTest("g-r3", { group: "Leave Me" });

    const res = await invokeHandler<{ changed: number }>("tests:renameGroup", {
      from: "Rename Me",
      to: "Renamed",
    });

    expect(res.changed).toBe(2);
    expect(testStore.get("g-r1")?.group).toBe("Renamed");
    expect(testStore.get("g-r2")?.group).toBe("Renamed");
    expect(testStore.get("g-r3")?.group).toBe("Leave Me");
  });

  it("is CASE-SENSITIVE, unlike deleting a tag", async () => {
    // A tag is matched, so its two spellings have to be one chip. A group is
    // only ever displayed, so two spellings are two folders and renaming one
    // must not silently swallow the other.
    seedTest("g-case1", { group: "Casing" });
    seedTest("g-case2", { group: "casing" });

    await invokeHandler("tests:renameGroup", { from: "Casing", to: "Upper" });

    expect(testStore.get("g-case1")?.group).toBe("Upper");
    expect(testStore.get("g-case2")?.group).toBe("casing");
  });

  it("deletes a group by renaming it to nothing", async () => {
    // There is no group record to remove, so this is the only deletion there
    // is — and the tests survive it, one row higher.
    seedTest("g-drop", { group: "Dropping" });
    const res = await invokeHandler<{ changed: number }>("tests:renameGroup", {
      from: "Dropping",
      to: "",
    });
    expect(res.changed).toBe(1);
    expect("group" in (testStore.get("g-drop") as TestRecord)).toBe(false);
  });

  it("refuses a rename with no source rather than touching every ungrouped test", async () => {
    await expect(invokeHandler("tests:renameGroup", { from: "  ", to: "X" })).rejects.toThrow(
      /required/i,
    );
    await expect(invokeHandler("tests:renameGroup", { from: 42, to: "X" })).rejects.toThrow(
      /required/i,
    );
  });

  it("reaches a HIDDEN test, which would otherwise bring the old name back", async () => {
    // Same reasoning as `removeTag`: a name left on a hidden test is invisible
    // right up until that test is unhidden.
    seedTest("g-hidden", { group: "Hiding", hidden: true });
    await invokeHandler("tests:renameGroup", { from: "Hiding", to: "Found" });
    expect(testStore.get("g-hidden")?.group).toBe("Found");
  });
});

describe("tests:deleteTag — library-wide removal", () => {
  // Tag names here are deliberately unique to this block: the store is shared
  // across the whole file, so a tag another describe seeded would be counted
  // too and the expected numbers would drift as tests are added.
  it("removes the tag from every test carrying it, in any casing, and leaves the rest alone", async () => {
    seedTest("t-del-1", { tags: ["keepme", "burnme"] });
    seedTest("t-del-2", { tags: ["BurnMe"] });
    seedTest("t-del-3", { tags: ["keepme"] });

    const res = await invokeHandler<{ tag: string; removed: number }>("tests:deleteTag", {
      tag: "BURNME",
    });

    // Both spellings go: the UI groups them into one chip, so leaving "Smoke"
    // behind would bring the chip straight back with a count nobody can explain.
    expect(res.removed).toBe(2);
    expect(testStore.get("t-del-1")?.tags).toEqual(["keepme"]);
    expect(testStore.get("t-del-2")?.tags).toEqual([]);
    expect(testStore.get("t-del-3")?.tags).toEqual(["keepme"]);
  });

  it("deletes the tag from HIDDEN tests too", async () => {
    // testStore.list() filters hidden tests out, so a tag left on one is
    // invisible until the test is unhidden — at which point a tag the user
    // deleted reappears.
    seedTest("t-del-hidden", { tags: ["nightly"], hidden: true });
    seedTest("t-del-visible", { tags: ["nightly"] });

    const res = await invokeHandler<{ removed: number }>("tests:deleteTag", { tag: "nightly" });

    expect(res.removed).toBe(2);
    expect(testStore.get("t-del-hidden")?.tags).toEqual([]);
  });

  it("reports the canonical tag and normalizes what it was given", async () => {
    seedTest("t-del-canon", { tags: ["slow path"] });
    // Same trip through normalizeTags as tests:setTags — untrimmed, inner
    // whitespace collapsed — so the two can't disagree about what a tag is.
    const res = await invokeHandler<{ tag: string; removed: number }>("tests:deleteTag", {
      tag: "  slow   path  ",
    });
    expect(res.tag).toBe("slow path");
    expect(res.removed).toBe(1);
  });

  it("rejects hostile input rather than touching the library", async () => {
    seedTest("t-del-safe", { tags: ["keep"] });
    for (const tag of [null, undefined, 42, ["smoke"], { a: 1 }, "", "   "]) {
      await expect(invokeHandler("tests:deleteTag", { tag })).rejects.toThrow(/tag is required/i);
    }
    expect(testStore.get("t-del-safe")?.tags).toEqual(["keep"]);
  });

  it("reports 0 for a tag nobody uses instead of throwing", async () => {
    const res = await invokeHandler<{ removed: number }>("tests:deleteTag", { tag: "ghost" });
    expect(res.removed).toBe(0);
  });
});

describe("tests:setBrowser — engine validation", () => {
  it("accepts the three real engines", async () => {
    seedTest("t-browser");
    for (const b of ["chromium", "firefox", "webkit"]) {
      const rec = await invokeHandler<TestRecord>("tests:setBrowser", {
        id: "t-browser",
        runBrowser: b,
      });
      expect(rec.runBrowser).toBe(b);
    }
  });

  it("rejects an unknown engine instead of storing it", async () => {
    seedTest("t-browser2");
    // Storing it would hand the value straight to the Playwright CLI later.
    await expect(
      invokeHandler("tests:setBrowser", { id: "t-browser2", runBrowser: "netscape" }),
    ).rejects.toThrow(/unknown browser/i);
    expect(testStore.get("t-browser2")?.runBrowser).toBeUndefined();
  });
});

describe("batch:run — selection validation", () => {
  it("refuses an empty selection", async () => {
    await expect(invokeHandler("batch:run", { testIds: [] })).rejects.toThrow(/at least one/i);
  });

  it("refuses a non-array selection", async () => {
    await expect(invokeHandler("batch:run", { testIds: "all" })).rejects.toThrow(/at least one/i);
  });

  it("refuses a selection of only empty ids", async () => {
    await expect(invokeHandler("batch:run", { testIds: ["", ""] })).rejects.toThrow(/at least one/i);
  });
});

describe("alerts — the webhook URL is validated and never read back", () => {
  it("rejects non-http(s) schemes", async () => {
    for (const url of ["ftp://x/y", "file:///etc/passwd", "javascript:alert(1)", "nonsense", ""]) {
      await expect(invokeHandler("alerts:setWebhookUrl", { url })).rejects.toThrow();
    }
  });

  it("reports only whether a URL exists and its host, never the URL", async () => {
    const saved = await invokeHandler<{ hasUrl: boolean; host: string | null }>(
      "alerts:setWebhookUrl",
      { url: "https://hooks.example.com/services/SECRET-TOKEN" },
    );
    expect(saved.hasUrl).toBe(true);
    expect(saved.host).toBe("hooks.example.com");
    // The URL is a bearer credential: it must not cross back over IPC.
    expect(JSON.stringify(saved)).not.toContain("SECRET-TOKEN");

    const status = await invokeHandler<{ hasUrl: boolean; host: string | null }>("alerts:status");
    expect(JSON.stringify(status)).not.toContain("SECRET-TOKEN");
  });

  it("clears the stored URL", async () => {
    await invokeHandler("alerts:setWebhookUrl", { url: "https://hooks.example.com/x" });
    const cleared = await invokeHandler<{ hasUrl: boolean }>("alerts:clearWebhookUrl");
    expect(cleared.hasUrl).toBe(false);
  });

  it("refuses to send a test alert with no URL configured", async () => {
    await invokeHandler("alerts:clearWebhookUrl");
    await expect(invokeHandler("alerts:test")).rejects.toThrow(/no webhook url/i);
  });
});

describe("shopify — a signature crosses IPC once, in one direction", () => {
  const INPUT =
    'sig1=("@authority");created=1735689600;expires=4102444799;keyid="kkk";alg="ed25519"';
  const VALUE = "sig1=:dGhpcy1pcy1zZWNyZXQ=:";

  it("reports host, expiry and state — never a header value", async () => {
    const saved = await invokeHandler<{ id: string; host: string; expiresAt: number | null }>(
      "shopify:add",
      { host: "https://Shop.Example.com/collections", signatureInput: INPUT, signature: VALUE },
    );
    expect(saved.host).toBe("shop.example.com");
    expect(saved.expiresAt).toBe(4102444799);
    // The values are a bearer credential for the store: they go in, and nothing
    // that comes back may carry them.
    expect(JSON.stringify(saved)).not.toContain("dGhpcy1pcy1zZWNyZXQ=");
    expect(JSON.stringify(saved)).not.toContain("keyid");

    const list = await invokeHandler<unknown[]>("shopify:list");
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("dGhpcy1pcy1zZWNyZXQ=");
    expect(JSON.stringify(list)).not.toContain("ed25519");

    await invokeHandler("shopify:remove", { id: saved.id });
    expect(await invokeHandler<unknown[]>("shopify:list")).toEqual([]);
  });

  it("refuses a paste it cannot use, saying which field was wrong", async () => {
    await expect(
      invokeHandler("shopify:add", {
        host: "not a domain",
        signatureInput: INPUT,
        signature: VALUE,
      }),
    ).rejects.toThrow(/domain/i);
    // A CRLF in a header value is header injection, and this value ends up
    // concatenated into a request by both the trainer and the run fixture.
    await expect(
      invokeHandler("shopify:add", {
        host: "shop.example.com",
        signatureInput: INPUT,
        signature: "sig1=:a:\r\nX-Injected: 1",
      }),
    ).rejects.toThrow(/line break|can't appear/i);
    expect(await invokeHandler<unknown[]>("shopify:list")).toEqual([]);
  });
});

describe("issues — the key never comes back, and the patch keeps its shape", () => {
  // `connect` verifies, and verification is a network call. Stubbed so this
  // suite makes no outbound request: a unit test that reaches api.linear.app is
  // slow, flaky, and sends a fake credential to a third party on every CI run.
  // The provider looks `fetch` up per request precisely so this works.
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { viewer: { name: "Sam" }, organization: { name: "Northwind" } } }),
    })) as unknown as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it("reports only whether a key exists and whose it is, never the key", async () => {
    const status = await invokeHandler<{ hasKey: boolean }>("issues:connect", {
      key: "lin_api_SECRET-TOKEN",
    });
    expect(status.hasKey).toBe(true);
    expect(JSON.stringify(status)).not.toContain("SECRET-TOKEN");

    const read = await invokeHandler("issues:status");
    expect(JSON.stringify(read)).not.toContain("SECRET-TOKEN");
  });

  it("keeps `omitted` and `null` distinct across IPC", async () => {
    // The distinction the whole defaults API rests on: omitting a field means
    // "leave it alone", passing null means "clear it". A handler that spread
    // its params, or defaulted a missing key to null, would collapse the two —
    // and clearing a default would become impossible to express while looking
    // like it worked.
    await invokeHandler("issues:setDefaults", { containerId: "t1", subContainerId: "p1" });

    const omitted = await invokeHandler<{ containerId: string | null; subContainerId: string | null }>(
      "issues:setDefaults",
      { containerId: "t1" },
    );
    expect(omitted.subContainerId).toBe("p1");

    const cleared = await invokeHandler<{ subContainerId: string | null }>("issues:setDefaults", {
      subContainerId: null,
    });
    expect(cleared.subContainerId).toBeNull();
  });

  it("clears the defaults when the key is removed", async () => {
    // A team id is only meaningful inside the workspace that key opened.
    await invokeHandler("issues:connect", { key: "lin_api_ANOTHER" });
    await invokeHandler("issues:setDefaults", { containerId: "t9", subContainerId: "p9" });
    await invokeHandler("issues:disconnect");
    expect(await invokeHandler("issues:getDefaults")).toEqual({
      containerId: null,
      subContainerId: null,
    });
  });
});

describe("recorder:setSettings — persistence and validation", () => {
  it("round-trips a setting", async () => {
    await invokeHandler("recorder:setSettings", { defaultRunBrowser: "webkit" });
    const s = await invokeHandler<{ defaultRunBrowser: string }>("recorder:getSettings");
    expect(s.defaultRunBrowser).toBe("webkit");
  });

  it("ignores an invalid engine rather than persisting it", async () => {
    await invokeHandler("recorder:setSettings", { defaultRunBrowser: "webkit" });
    await invokeHandler("recorder:setSettings", { defaultRunBrowser: "netscape" });
    const s = await invokeHandler<{ defaultRunBrowser: string }>("recorder:getSettings");
    expect(s.defaultRunBrowser).toBe("webkit");
  });

  // ── The appearance settings ─────────────────────────────────────────
  //
  // `uiScale` is the one setting in this file whose bad values are not merely
  // ignored downstream: it is handed to `webContents.setZoomFactor` for every
  // app window, so a `0` or a `1e9` that got through would draw the whole app —
  // INCLUDING the Settings window that is the only way to change it back — at a
  // size from which nothing can be read or clicked. There is no recovery path
  // in the UI, which is why the validator is membership in a set of four and
  // not a clamp, and why these cases are pinned by name.

  it("round-trips a scale it recognises", async () => {
    await invokeHandler("recorder:setSettings", { uiScale: 1.25 });
    const s = await invokeHandler<{ uiScale: number }>("recorder:getSettings");
    expect(s.uiScale).toBe(1.25);
  });

  it("refuses a scale that would make the app unusable", async () => {
    await invokeHandler("recorder:setSettings", { uiScale: 1.1 });
    for (const bad of [0, -1, NaN, 1e9, Infinity, "large", "1.25", null, {}, []]) {
      await invokeHandler("recorder:setSettings", { uiScale: bad });
      const s = await invokeHandler<{ uiScale: number }>("recorder:getSettings");
      expect(s.uiScale, String(bad)).toBe(1.1);
    }
  });

  it("refuses a scale that is merely between two it allows", async () => {
    // The separate case because it is the one a range clamp would accept: 1.05
    // is in bounds and would round to something plausible. The set is closed so
    // the pane and the store cannot disagree about what a size means.
    await invokeHandler("recorder:setSettings", { uiScale: 1 });
    await invokeHandler("recorder:setSettings", { uiScale: 1.05 });
    const s = await invokeHandler<{ uiScale: number }>("recorder:getSettings");
    expect(s.uiScale).toBe(1);
  });

  it("round-trips a typeface it recognises", async () => {
    await invokeHandler("recorder:setSettings", { uiTypeface: "classic" });
    const s = await invokeHandler<{ uiTypeface: string }>("recorder:getSettings");
    expect(s.uiTypeface).toBe("classic");
  });

  it("refuses a typeface that is not one of the three", async () => {
    // The string is written into a `data-` attribute the stylesheet selects on.
    // A rejected value is invisible either way — an unmatched selector styles
    // nothing — so the refusal has to happen here, where it can be seen.
    await invokeHandler("recorder:setSettings", { uiTypeface: "system" });
    for (const bad of ["comic sans", 'space"] {}', "Space", "", 42, null, ["space"]]) {
      await invokeHandler("recorder:setSettings", { uiTypeface: bad });
      const s = await invokeHandler<{ uiTypeface: string }>("recorder:getSettings");
      expect(s.uiTypeface, String(bad)).toBe("system");
    }
  });

  it("a partial update preserves the other settings", async () => {
    // Every feature writes settings independently; a merge bug here would drop
    // unrelated preferences on each save.
    await invokeHandler("recorder:setSettings", { batchOrder: ["a", "b"], notifyOnRunIssues: true });
    await invokeHandler("recorder:setSettings", { defaultRunHeadless: true });
    const s = await invokeHandler<{
      batchOrder: string[];
      notifyOnRunIssues: boolean;
      defaultRunHeadless: boolean;
    }>("recorder:getSettings");
    expect(s.batchOrder).toEqual(["a", "b"]);
    expect(s.notifyOnRunIssues).toBe(true);
    expect(s.defaultRunHeadless).toBe(true);
  });

  it("keeps only string entries in batchOrder", async () => {
    await invokeHandler("recorder:setSettings", { batchOrder: ["a", 5, null, "b"] });
    const s = await invokeHandler<{ batchOrder: string[] }>("recorder:getSettings");
    expect(s.batchOrder).toEqual(["a", "b"]);
  });

  it("defaults batch concurrency to one at a time", async () => {
    // Parallel batches multiply CPU load and, run headed, open a browser window
    // per test. Nobody gets that without asking for it.
    const initial = await invokeHandler<{ defaultBatchConcurrency: number }>(
      "recorder:getSettings",
    );
    expect(initial.defaultBatchConcurrency).toBe(1);
  });

  it("clamps batch concurrency into range and ignores nonsense", async () => {
    const read = async () =>
      (await invokeHandler<{ defaultBatchConcurrency: number }>("recorder:getSettings"))
        .defaultBatchConcurrency;

    await invokeHandler("recorder:setSettings", { defaultBatchConcurrency: 4 });
    expect(await read()).toBe(4);

    // Each of these would otherwise be handed to the batch runner as "how many
    // browsers to open at once".
    await invokeHandler("recorder:setSettings", { defaultBatchConcurrency: 9999 });
    expect(await read()).toBe(16);

    await invokeHandler("recorder:setSettings", { defaultBatchConcurrency: 0 });
    expect(await read()).toBe(1);

    await invokeHandler("recorder:setSettings", { defaultBatchConcurrency: -5 });
    expect(await read()).toBe(1);

    // A non-number keeps the stored value rather than collapsing to the floor:
    // `Math.round(null)` is 0, which would silently turn "4 at once" back off.
    await invokeHandler("recorder:setSettings", { defaultBatchConcurrency: 8 });
    for (const bad of ["4", null, Number.NaN, Infinity, {}]) {
      await invokeHandler("recorder:setSettings", { defaultBatchConcurrency: bad });
      expect(await read()).toBe(8);
    }
  });

  it("defaults the per-test timeout to one minute and clamps on save", async () => {
    const initial = await invokeHandler<{ defaultTestTimeoutMs: number }>("recorder:getSettings");
    expect(initial.defaultTestTimeoutMs).toBe(60_000);

    await invokeHandler("recorder:setSettings", { defaultTestTimeoutMs: 120_000 });
    const raised = await invokeHandler<{ defaultTestTimeoutMs: number }>("recorder:getSettings");
    expect(raised.defaultTestTimeoutMs).toBe(120_000);

    // Below the floor — ignored, previous value kept (same as an invalid browser).
    await invokeHandler("recorder:setSettings", { defaultTestTimeoutMs: 100 });
    const floor = await invokeHandler<{ defaultTestTimeoutMs: number }>("recorder:getSettings");
    expect(floor.defaultTestTimeoutMs).toBe(120_000);

    // Above the ceiling — clamped rather than rejected, so a fat-fingered
    // "999999999" still lands somewhere usable.
    await invokeHandler("recorder:setSettings", { defaultTestTimeoutMs: 999_999_999 });
    const ceiling = await invokeHandler<{ defaultTestTimeoutMs: number }>("recorder:getSettings");
    expect(ceiling.defaultTestTimeoutMs).toBe(30 * 60 * 1000);
  });
});

describe("tests:setTestTimeout — per-test override", () => {
  it("stores a clamped override and clears it on null", async () => {
    seedTest("t-timeout");
    const set = await invokeHandler<TestRecord>("tests:setTestTimeout", {
      id: "t-timeout",
      testTimeoutMs: 180_000,
    });
    expect(set.testTimeoutMs).toBe(180_000);

    const cleared = await invokeHandler<TestRecord>("tests:setTestTimeout", {
      id: "t-timeout",
      testTimeoutMs: null,
    });
    expect(cleared.testTimeoutMs).toBeUndefined();
  });

  it("rejects a timeout below the floor", async () => {
    seedTest("t-timeout-bad");
    await expect(
      invokeHandler("tests:setTestTimeout", { id: "t-timeout-bad", testTimeoutMs: 50 }),
    ).rejects.toThrow(/invalid test timeout/i);
  });
});

// ── tests:setBaseUrl — what an imported spec's relative navigations resolve
//    against ──────────────────────────────────────────────────────────────
//
// The only field on a test record that the user types in and that ends up in
// the ENVIRONMENT of the spawned Playwright process (`PW_BASE_URL`), where it
// is prepended to every relative `page.goto("/")` in an imported suite. So it
// is a boundary value twice over: unknown from the renderer on the way in, and
// a URL something else navigates to on the way out.
//
// Params are passed as `unknown` deliberately. The handler's TypeScript
// signature says `{ id: string; baseUrl: string | null }`, and a type is not a
// runtime check — the renderer is the untrusted caller here, so these tests
// call it the way a broken (or hostile) one would.
describe("tests:setBaseUrl — validating the URL an imported test runs against", () => {
  const setBaseUrl = (params: unknown) => invokeHandler<TestRecord>("tests:setBaseUrl", params);

  it("stores the normalized href rather than the string it was handed", async () => {
    // seedTest stamps updatedAt: 1, so "the clock moved" is unambiguous.
    seedTest("t-baseurl");

    const rec = await setBaseUrl({ id: "t-baseurl", baseUrl: "https://example.com" });

    // Through `new URL(...).href` — the same gate the config parser hands its
    // findings through, so a URL typed in and a URL read off someone's
    // playwright.config are held to one standard and cannot disagree about
    // what "https://example.com" means when "/cart" is resolved against it.
    expect(rec.baseUrl).toBe("https://example.com/");
    expect(testStore.get("t-baseurl")?.baseUrl).toBe("https://example.com/");
    expect(rec.updatedAt).toBeGreaterThan(1);
  });

  it("keeps a path prefix and accepts plain http, which is what a dev server is", async () => {
    // Both halves are load-bearing for the feature's actual job. The suite this
    // was written against points at `http://localhost:3000` — refusing http
    // would refuse the common case — and a base URL with a path is the reason
    // `/cart` reaches `/app/cart`, so normalization must not eat the prefix.
    seedTest("t-baseurl-shapes");

    const local = await setBaseUrl({ id: "t-baseurl-shapes", baseUrl: "  http://localhost:3000  " });
    expect(local.baseUrl).toBe("http://localhost:3000/");

    const nested = await setBaseUrl({
      id: "t-baseurl-shapes",
      baseUrl: "https://staging.example.com/app",
    });
    expect(nested.baseUrl).toBe("https://staging.example.com/app");
  });

  it("clears the field for null and for anything an emptied input box sends", async () => {
    // The Base URL input persists on blur, so "the user selected the text and
    // deleted it" arrives here as "" or as whitespace — not as null. All three
    // have to mean the same thing, or a cleared box comes back populated on the
    // next render and the user cannot get rid of a wrong URL.
    for (const empty of [null, "", "   ", "\t\n "]) {
      seedTest("t-baseurl-clear", { baseUrl: "https://example.com/" });

      const rec = await setBaseUrl({ id: "t-baseurl-clear", baseUrl: empty });

      expect(rec.baseUrl, JSON.stringify(empty)).toBeUndefined();
      expect(testStore.get("t-baseurl-clear")?.baseUrl, JSON.stringify(empty)).toBeUndefined();
    }
  });

  it("refuses anything that is not a full http(s) address, and leaves the record alone", async () => {
    // A rejected value must not half-land: the record keeps the URL it had, and
    // its updatedAt does not move, which is what pins that the throw happens
    // BEFORE the mutate-and-save rather than after it.
    seedTest("t-baseurl-bad", { baseUrl: "https://kept.example.com/" });
    const before = testStore.get("t-baseurl-bad")!;

    for (const bad of [
      "example.com", // a bare host: nothing to resolve "/cart" against
      "localhost:3000", // reads as a URL with a `localhost:` scheme, which it is not
      "javascript:alert(1)", // handed to a browser to navigate to
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "https://${HOST}/app", // a template literal nobody interpolated
      "/cart", // relative — this field is the thing relatives resolve against
      42,
      true,
      { href: "https://example.com" },
      ["https://example.com"], // stringifies to a valid URL; it is still not a string
    ]) {
      await expect(
        setBaseUrl({ id: "t-baseurl-bad", baseUrl: bad }),
        JSON.stringify(bad),
      ).rejects.toThrow(/invalid base url/i);

      const after = testStore.get("t-baseurl-bad")!;
      expect(after.baseUrl, JSON.stringify(bad)).toBe("https://kept.example.com/");
      expect(after.updatedAt, JSON.stringify(bad)).toBe(before.updatedAt);
    }
  });

  it("rejects an unknown test id rather than inventing a record to hold the URL", async () => {
    await expect(
      setBaseUrl({ id: "t-baseurl-nope", baseUrl: "https://example.com" }),
    ).rejects.toThrow(/not found/i);
    expect(testStore.get("t-baseurl-nope")).toBeNull();
  });
});

describe("recorder cookie handlers with no trainer window", () => {
  it("lists nothing rather than throwing", async () => {
    // The panel can be open with no recorder window; an empty list is the
    // honest answer, a crash is not.
    await expect(invokeHandler("recorder:listCookies")).resolves.toEqual([]);
  });

  it("reports a clear error when asked to set a cookie", async () => {
    await expect(
      invokeHandler("recorder:setCookie", { cookie: { name: "a", value: "b" } }),
    ).rejects.toThrow(/not open/i);
  });
});

// ── Creating a test ────────────────────────────────────────────────────────
//
// Four paths reach "a new test exists": the trainer (recorder:start, both for a
// new recording and for Edit in Trainer), prompt-driven generation, and the two
// imports. None had coverage, and manual creation silently broke — the home
// screen came back, no window, no test, no error.
//
// The trainer path creates a real BrowserWindow and can't run here; its
// regression is covered by trainer-window-gate.test.ts. What IS checkable at
// this boundary is that every path is reachable and that a created record is
// well-formed enough to run, list and open — which is what "the test was not
// created" actually means to a user.
describe("test creation paths", () => {
  it("registers every channel that can create a test", () => {
    // A path that stops being registered fails exactly the way the reported bug
    // did: the UI calls it, nothing happens, no error anywhere.
    for (const channel of [
      "recorder:start",
      "tests:createFromPrompt",
      "tests:importFiles",
      "tests:importGit",
    ]) {
      expect(registeredChannels(), `${channel} is not registered`).toContain(channel);
    }
  });

  // ── The browser chosen at creation ──────────────────────────────────────
  //
  // The engine was settable only from the test-detail toolbar, i.e. only after
  // the test existed. The renderer tests prove what the dialog SENDS; these
  // prove what the record ends up carrying, which is the half that decides
  // which browser a run actually spawns.
  //
  // An ABSENT field is the meaningful case, not the empty one: it is the
  // model's documented "inherit `defaultRunBrowser`", so a handler that
  // helpfully filled it in would quietly retire the Settings default.
  it("pins the engine a generated test was created with", async () => {
    const rec = await invokeHandler<TestRecord>("tests:createFromPrompt", {
      name: "On WebKit",
      url: "https://example.com",
      source: 'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      runBrowser: "webkit",
    });
    expect(rec.runBrowser).toBe("webkit");
  });

  it("leaves a generated test inheriting the default when none was chosen", async () => {
    const rec = await invokeHandler<TestRecord>("tests:createFromPrompt", {
      name: "Inherits",
      url: "https://example.com",
      source: 'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
    });
    expect(rec.runBrowser).toBeUndefined();
  });

  it("refuses an engine that is not one of the three", async () => {
    // The field reaches the runner and decides which Playwright project is
    // spawned. It arrives over IPC, so a TypeScript type is not a check.
    const rec = await invokeHandler<TestRecord>("tests:createFromPrompt", {
      name: "Nonsense",
      url: "https://example.com",
      source: 'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      runBrowser: "netscape",
    });
    expect(rec.runBrowser).toBeUndefined();
  });

  it("creates a runnable record from a generated script", async () => {
    const rec = await invokeHandler<TestRecord>("tests:createFromPrompt", {
      name: "  Generated checkout  ",
      url: "https://example.com",
      source: 'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
    });

    expect(rec.id).toBeTruthy();
    expect(rec.name).toBe("Generated checkout"); // trimmed
    // A test the runner can't find a script for is created-but-broken, which is
    // worse than not created at all.
    expect(rec.scriptPath).toBeTruthy();
    expect(fs.existsSync(rec.scriptPath)).toBe(true);
    // The model's file is the runnable artifact, so it must be flagged as
    // hand-edited or a later rename would regenerate a spec over it from the
    // (lossy) parsed steps.
    expect(rec.scriptEdited).toBe(true);
    // An empty test body genuinely has no steps — the point here is that this
    // is the parse result, not a hardcoded [].
    expect(rec.steps).toEqual([]);
  });

  // The generated spec is the ONLY description of a prompt-driven test, so if
  // it isn't translated into the Step[] model the detail view hides the Steps
  // tab outright (it renders only when steps.length > 0) — the test looks like
  // generation half-worked, with no per-step rows to inspect, replay or debug.
  it("translates a generated spec into listable steps", async () => {
    const rec = await invokeHandler<TestRecord>("tests:createFromPrompt", {
      name: "Sign in",
      url: "https://example.com",
      source: [
        "import { test, expect } from '@playwright/test';",
        "",
        "test('Sign in', async ({ page }) => {",
        "  await page.goto('https://example.com');",
        "  await page.getByLabel('Email').fill('test@example.com');",
        "  await page.getByRole('button', { name: 'Sign in' }).click();",
        "  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();",
        "});",
        "",
      ].join("\n"),
    });

    expect(rec.steps.map((s) => s.type)).toEqual(["goto", "fill", "click", "assert"]);
    // Locators have to survive the translation too: a step row with no locator
    // can't be replayed or healed, so a step list of the right LENGTH can still
    // be useless.
    expect(rec.steps[1].locator).toMatchObject({ k: "label", v: "Email" });
    expect(rec.steps[2].locator).toMatchObject({ k: "role", role: "button", name: "Sign in" });
    expect(rec.steps[3].assert).toBe("visible");
    // Everything mapped, so the "steps may not reflect the script" banner must
    // stay down — a warning on a clean parse trains the user to ignore it.
    expect(rec.stepsDiverged).toBe(false);
  });

  it("flags a generated spec whose statements it could not fully map", async () => {
    const rec = await invokeHandler<TestRecord>("tests:createFromPrompt", {
      name: "Partly parseable",
      url: "https://example.com",
      source: [
        "import { test, expect } from '@playwright/test';",
        "",
        "test('Partly parseable', async ({ page }) => {",
        "  await page.goto('https://example.com');",
        "  await page.evaluate(() => window.scrollTo(0, 500));",
        "});",
        "",
      ].join("\n"),
    });

    // Steps are an undercount of the script here. Showing them without saying
    // so is the silent failure: the user reads the Steps tab as the whole test.
    expect(rec.stepsDiverged).toBe(true);
  });

  it("still creates a test when the generated spec cannot be parsed at all", async () => {
    // Parsing is a nicety; the script runs either way. A spec the parser
    // chokes on must not cost the user their generated test.
    const rec = await invokeHandler<TestRecord>("tests:createFromPrompt", {
      name: "Unparseable",
      url: "https://example.com",
      source: "// the model returned prose, not a spec\n",
    });
    expect(rec.id).toBeTruthy();
    expect(rec.steps).toEqual([]);
    expect(fs.existsSync(rec.scriptPath)).toBe(true);
  });

  it("makes a created test immediately listable and fetchable", async () => {
    // "The test is not created" is what the user SEES — so the check is that it
    // shows up where they'd look, not merely that a function returned an object.
    const rec = await invokeHandler<TestRecord>("tests:createFromPrompt", {
      name: "Listable",
      url: "https://example.com",
      source: "// spec",
    });
    const listed = await invokeHandler<TestRecord[]>("tests:list");
    expect(listed.map((t) => t.id)).toContain(rec.id);
    const fetched = await invokeHandler<TestRecord | null>("tests:get", { id: rec.id });
    expect(fetched?.name).toBe("Listable");
  });

  it("falls back to a name rather than creating an unnamed test", async () => {
    const rec = await invokeHandler<TestRecord>("tests:createFromPrompt", {
      name: "   ",
      url: "https://example.com",
      source: "// spec",
    });
    expect(rec.name.trim()).not.toBe("");
  });

  it("refuses a git import with no URL instead of creating nothing quietly", async () => {
    // The import paths reach the filesystem and a network clone, so what's
    // checked here is the boundary: a missing URL is reported, not swallowed.
    await expect(invokeHandler("tests:importGit", {})).rejects.toThrow();
  });
});

// ── Editing steps ──────────────────────────────────────────────────────────
//
// "Edit Steps" saves a step list; the .spec.ts is what actually runs. For a
// test whose script isn't generated from its steps — hand-edited, imported, or
// written by the model from a prompt — those two can disagree, and this handler
// decides which one wins. It used to save the steps, skip the regeneration and
// say nothing: the Steps tab updated, the run didn't, and nothing on screen
// admitted it. So what's pinned here is not just "does it regenerate" but
// "does the record afterwards describe what will actually run".
describe("tests:updateSteps — steps, script, and whether they agree", () => {
  const HAND_EDITED = "// hand-written by the user, not generated\n";

  /** A one-step list that lands in the generated spec verbatim, so the script
   *  file can be read back to tell regenerated from untouched. */
  function stepsFor(url: string): Step[] {
    return [{ id: "s1", timestamp: 1, type: "goto", url } as Step];
  }

  it("regenerates the script when the script is generated from the steps", async () => {
    const rec = seedTest("t-steps-plain");
    testStore.writeScript(rec.id, HAND_EDITED);

    const updated = await invokeHandler<TestRecord>("tests:updateSteps", {
      id: rec.id,
      steps: stepsFor("https://regenerated.test/"),
    });

    expect(fs.readFileSync(updated.scriptPath, "utf-8")).toContain("https://regenerated.test/");
    expect(updated.stepsDiverged).toBe(false);
  });

  it("keeps a hand-edited script but records that the steps aren't in it", async () => {
    const rec = seedTest("t-steps-edited");
    rec.scriptEdited = true;
    testStore.save(rec);
    testStore.writeScript(rec.id, HAND_EDITED);

    const updated = await invokeHandler<TestRecord>("tests:updateSteps", {
      id: rec.id,
      steps: stepsFor("https://never-ran.test/"),
    });

    // The edit IS saved — that half always worked.
    expect(updated.steps.map((s) => s.type)).toEqual(["goto"]);
    // And the script is still the user's, untouched.
    expect(fs.readFileSync(updated.scriptPath, "utf-8")).toBe(HAND_EDITED);
    // The part that was missing: the record now admits the two disagree, which
    // is what puts the warning on screen. Without it the user is told nothing.
    expect(updated.stepsDiverged).toBe(true);
    expect(updated.stepsDivergedReason).toBe("unapplied");
  });

  it("regenerates over a hand-edited script when explicitly asked, and stops calling it hand-edited", async () => {
    const rec = seedTest("t-steps-regen");
    rec.scriptEdited = true;
    testStore.save(rec);
    testStore.writeScript(rec.id, HAND_EDITED);

    const updated = await invokeHandler<TestRecord>("tests:updateSteps", {
      id: rec.id,
      steps: stepsFor("https://applied.test/"),
      regenerate: true,
    });

    expect(fs.readFileSync(updated.scriptPath, "utf-8")).toContain("https://applied.test/");
    expect(updated.stepsDiverged).toBe(false);
    expect(updated.stepsDivergedReason).toBeUndefined();
    // The spec is generated from the steps again. Leaving the flag set would
    // keep warning about edits that no longer exist and, worse, would make the
    // NEXT step edit a no-op all over again.
    expect(updated.scriptEdited).toBe(false);
  });

  it("takes only a real boolean as permission to overwrite the script", async () => {
    // Same boundary rule as everything else the renderer sends: this one
    // authorizes destroying the user's script, so a truthy string is not a yes.
    const rec = seedTest("t-steps-truthy");
    rec.scriptEdited = true;
    testStore.save(rec);
    testStore.writeScript(rec.id, HAND_EDITED);

    const updated = await invokeHandler<TestRecord>("tests:updateSteps", {
      id: rec.id,
      steps: stepsFor("https://not-authorized.test/"),
      regenerate: "true",
    });

    expect(fs.readFileSync(updated.scriptPath, "utf-8")).toBe(HAND_EDITED);
    expect(updated.stepsDiverged).toBe(true);
  });

  it("never regenerates an imported test's verbatim spec, even when asked to", async () => {
    // An imported spec is a file someone else wrote, sitting next to the sibling
    // modules it imports. A generated one carries neither those imports nor
    // anything else the parser couldn't classify — and the original is gone.
    const id = "t-steps-imported";
    const rec = seedTest(id);
    rec.scriptEdited = true;
    rec.sourceDir = "/somewhere/else/tests";
    rec.scriptPath = path.join(userData, "recorder", "scripts", "imported", id, "checkout.spec.ts");
    testStore.save(rec);
    fs.mkdirSync(path.dirname(rec.scriptPath), { recursive: true });
    fs.writeFileSync(rec.scriptPath, HAND_EDITED, "utf-8");

    const updated = await invokeHandler<TestRecord>("tests:updateSteps", {
      id,
      steps: stepsFor("https://would-have-clobbered.test/"),
      regenerate: true,
    });

    expect(fs.readFileSync(updated.scriptPath, "utf-8")).toBe(HAND_EDITED);
    expect(updated.scriptEdited).toBe(true);
    expect(updated.stepsDiverged).toBe(true);
  });
});

// Silencing the divergence warning, and — the part that carries the risk —
// knowing when to stop silencing it.
//
// A dismissal that outlived the divergence it acknowledged would hide the NEXT
// one, and the next one is the case the warning exists for: an applied AI-debug
// fix whose script doesn't come back as steps, so the Steps tab is quietly
// describing something other than what runs. That failure is completely silent
// on screen, which is why it is pinned here rather than left to the renderer.
describe("tests:dismissDiverged — silencing the warning, and re-arming it", () => {
  /** A spec with a statement the parser cannot classify, which is what makes a
   *  re-parse report `skipped > 0` and set the "parse" divergence. */
  const UNPARSEABLE =
    "import { test } from '@playwright/test';\n" +
    "test('t', async ({ page }) => {\n" +
    "  await page.goto('https://example.com');\n" +
    "  await page.evaluate(() => window.scrollBy(0, 500));\n" +
    "});\n";

  it("records the dismissal without pretending the test agrees with its script", async () => {
    const rec = seedTest("t-dismiss", { stepsDiverged: true, stepsDivergedReason: "parse" });
    const updated = await invokeHandler<TestRecord>("tests:dismissDiverged", { id: rec.id });

    expect(updated.stepsDivergedDismissed).toBe(true);
    // The distinction the whole feature rests on: the two really ARE out of
    // sync, and everything else reading the flag — the run comparison, the MCP
    // — must keep saying so. Only the banner is silenced.
    expect(updated.stepsDiverged).toBe(true);
    expect(testStore.get(rec.id)?.stepsDivergedDismissed).toBe(true);
  });

  it("comes back for a divergence the user hasn't seen", async () => {
    const rec = seedTest("t-dismiss-rearm", {
      stepsDiverged: true,
      stepsDivergedReason: "parse",
      stepsDivergedDismissed: true,
    });

    // The AI-debug apply path: a new script that won't fully parse back.
    const updated = await invokeHandler<TestRecord>("tests:updateScript", {
      id: rec.id,
      source: UNPARSEABLE,
    });

    expect(updated.stepsDiverged).toBe(true);
    expect(updated.stepsDivergedReason).toBe("parse");
    expect(updated.stepsDivergedDismissed).toBeUndefined();
  });

  it("comes back when saved steps are left out of the script", async () => {
    const rec = seedTest("t-dismiss-unapplied", {
      scriptEdited: true,
      stepsDiverged: true,
      stepsDivergedReason: "unapplied",
      stepsDivergedDismissed: true,
    });
    testStore.writeScript(rec.id, "// hand-written\n");

    const updated = await invokeHandler<TestRecord>("tests:updateSteps", {
      id: rec.id,
      steps: [{ id: "s1", timestamp: 1, type: "goto", url: "https://new.test/" } as Step],
    });

    // Same rule, other cause: these are different edits from the ones that were
    // acknowledged, so the user has not seen this divergence either.
    expect(updated.stepsDiverged).toBe(true);
    expect(updated.stepsDivergedDismissed).toBeUndefined();
  });

  it("clears the dismissal when the divergence is resolved", async () => {
    // Nothing to acknowledge any more. Leaving a stale `true` on the record is
    // how the next real divergence gets silenced by a click made months ago.
    const rec = seedTest("t-dismiss-resolved", {
      stepsDiverged: true,
      stepsDivergedReason: "unapplied",
      stepsDivergedDismissed: true,
    });

    const updated = await invokeHandler<TestRecord>("tests:updateSteps", {
      id: rec.id,
      steps: [{ id: "s1", timestamp: 1, type: "goto", url: "https://resolved.test/" } as Step],
    });

    expect(updated.stepsDiverged).toBe(false);
    expect(updated.stepsDivergedDismissed).toBeUndefined();
  });

  it("takes `dismissed: false` as the way back", async () => {
    const rec = seedTest("t-dismiss-undo", {
      stepsDiverged: true,
      stepsDivergedDismissed: true,
    });
    const updated = await invokeHandler<TestRecord>("tests:dismissDiverged", {
      id: rec.id,
      dismissed: false,
    });
    expect(updated.stepsDivergedDismissed).toBeUndefined();
  });
});

// The handler does one thing the service deliberately does not: carry the
// encrypted secret values across, and tell redaction about the new test id.
// Both are invisible when wrong. A copy missing its secrets fails on its first
// run naming an env var the user has never seen; a copy whose secrets never
// reached the redaction snapshot writes that password into a run log in
// plaintext, which is the failure the secret store exists to prevent.
describe("tests:duplicate — the copy, its secrets, and its history", () => {
  it("returns a separate record with a numbered name", async () => {
    seedTest("t-dup");

    const copy = await invokeHandler<TestRecord>("tests:duplicate", { id: "t-dup" });

    expect(copy.id).not.toBe("t-dup");
    expect(copy.name).toBe("Test t-dup [2]");
    expect(testStore.get("t-dup")).not.toBeNull();
    expect(testStore.get(copy.id)).not.toBeNull();
  });

  it("writes the copy its own script file", async () => {
    const src = seedTest("t-dup-script", { url: "https://example.com/one" });
    fs.mkdirSync(path.dirname(src.scriptPath), { recursive: true });
    fs.writeFileSync(src.scriptPath, 'test("Test t-dup-script", async () => {});', "utf-8");

    const copy = await invokeHandler<TestRecord>("tests:duplicate", { id: "t-dup-script" });

    expect(copy.scriptPath).not.toBe(src.scriptPath);
    expect(fs.existsSync(copy.scriptPath)).toBe(true);
    expect(fs.existsSync(src.scriptPath)).toBe(true);
  });

  it("copies stored secret values so the copy can actually run", async () => {
    const id = "t-dup-secrets";
    seedTest(id, { variables: [{ name: "password", kind: "secret" }] });
    fs.mkdirSync(path.dirname(testStore.get(id)!.scriptPath), { recursive: true });
    fs.writeFileSync(testStore.get(id)!.scriptPath, "// spec", "utf-8");
    await invokeHandler("tests:setSecret", { id, name: "password", value: "hunter2" });

    const copy = await invokeHandler<TestRecord>("tests:duplicate", { id });

    // Asserted through the names-only status handler, which is the only way the
    // renderer can ever ask — there is no handler that reads a value back out.
    const status = await invokeHandler<{ name: string; hasValue: boolean }[]>(
      "tests:secretStatus",
      { id: copy.id },
    );
    expect(status).toEqual([{ name: "password", hasValue: true }]);
  });

  it("leaves the original's secrets in place", async () => {
    const id = "t-dup-secrets-src";
    seedTest(id, { variables: [{ name: "token", kind: "secret" }] });
    fs.mkdirSync(path.dirname(testStore.get(id)!.scriptPath), { recursive: true });
    fs.writeFileSync(testStore.get(id)!.scriptPath, "// spec", "utf-8");
    await invokeHandler("tests:setSecret", { id, name: "token", value: "abc123" });

    await invokeHandler<TestRecord>("tests:duplicate", { id });

    const status = await invokeHandler<{ name: string; hasValue: boolean }[]>(
      "tests:secretStatus",
      { id },
    );
    expect(status).toEqual([{ name: "token", hasValue: true }]);
  });

  it("copies no secrets for a test that has none", async () => {
    const id = "t-dup-nosecrets";
    seedTest(id);
    fs.mkdirSync(path.dirname(testStore.get(id)!.scriptPath), { recursive: true });
    fs.writeFileSync(testStore.get(id)!.scriptPath, "// spec", "utf-8");

    const copy = await invokeHandler<TestRecord>("tests:duplicate", { id });

    expect(
      await invokeHandler<unknown[]>("tests:secretStatus", { id: copy.id }),
    ).toEqual([]);
  });

  it("does not carry the accepted accessibility baseline", async () => {
    const id = "t-dup-a11y";
    seedTest(id, { a11yBaseline: { s1: ["color-contrast|button"] } });
    fs.mkdirSync(path.dirname(testStore.get(id)!.scriptPath), { recursive: true });
    fs.writeFileSync(testStore.get(id)!.scriptPath, "// spec", "utf-8");

    const copy = await invokeHandler<TestRecord>("tests:duplicate", { id });

    expect(copy.a11yBaseline).toBeUndefined();
  });

  it("rejects an unknown id rather than creating an empty test", async () => {
    await expect(invokeHandler("tests:duplicate", { id: "not-a-test" })).rejects.toThrow(
      /not found/i,
    );
  });
});

// ── tests:delete — everything a test leaves behind ───────────────────
//
// This handler had NO coverage, and it is the one place in the app where
// forgetting a store is completely silent: nothing errors, the test disappears
// from the library, and its leftovers surface weeks later under a name nobody
// recognises.
//
// Every store is asserted SEPARATELY rather than through one "it's clean"
// check. A single combined assertion passes vacuously the day a new per-test
// store is added and left out of the handler — which is exactly the failure
// mode these tests exist for.
//
// The dividing line being pinned: anything that NAMES the test or holds its
// CONTENT goes; the arithmetic stays. Run records survive as tombstones so the
// pass rate and the daily chart don't lurch when a test is deleted.
describe("tests:delete — what a deleted test leaves behind", () => {
  /** Seed a test plus one of everything that keys off its id. */
  function seedFullTest(id: string): { runId: string; scriptPath: string } {
    const rec = seedTest(id);
    fs.mkdirSync(path.dirname(rec.scriptPath), { recursive: true });
    fs.writeFileSync(rec.scriptPath, "// spec", "utf-8");

    const run = runHistoryStore.append(
      {
        testId: id,
        testName: rec.name,
        url: "https://example.com",
        status: "failed",
        exitCode: 1,
        startedAt: 1_000,
        finishedAt: 2_000,
      },
      "console output that quotes the page",
    );

    // A run's artifact directory, as the capture fixture would leave it.
    const runDir = artifactStore.runDir(id, run.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "0.png"), "png bytes", "utf-8");

    annotationStore.upsert(id, run.id, "s1", "a note about this step");
    healJournalStore.record({
      testId: id,
      stepId: "s1",
      stepIndex: 0,
      stepLabel: 'getByTestId("pay").click()',
      source: "run",
      appliedLocator: { k: "testid", v: "pay-v2" },
      candidates: [],
      applied: true,
    });
    aiDebugStore.save({
      key: `run:${id}`,
      kind: "run",
      testId: id,
      label: rec.name,
      testName: rec.name,
      status: "done",
      content: "the model quoting the script and the run output",
      reasoning: "",
      error: null,
      requestId: null,
      scriptHash: null,
      startedAt: 1,
      updatedAt: 1,
    });
    recorderDebugStore.append(id, {
      stepId: "s1",
      stepIndex: 1,
      stepLabel: "click",
      ok: false,
      at: 1,
      logs: [],
    });
    batchHistoryStore.save({
      batchId: `b-${id}`,
      running: false,
      startedAt: 1,
      finishedAt: 2,
      currentIndex: -1,
      stopped: false,
      results: [{ testId: id, testName: rec.name, status: "failed" }],
      summary: { total: 1, passed: 0, failed: 1, skipped: 0, ok: false, durationMs: 1 },
    });
    recorderSettingsStore.set({
      batchOrder: [id, "someone-else"],
      batchTestOptions: {
        [id]: { selected: true, browsers: ["webkit"], headless: true },
        "someone-else": { selected: false, browsers: ["chromium"], headless: false },
      },
    });

    return { runId: run.id, scriptPath: rec.scriptPath };
  }

  it("removes the record and its generated spec", async () => {
    const id = "t-del-record";
    const { scriptPath } = seedFullTest(id);

    await invokeHandler("tests:delete", { id });

    expect(testStore.get(id)).toBeNull();
    expect(fs.existsSync(scriptPath)).toBe(false);
  });

  it("removes the run's screenshots", async () => {
    const id = "t-del-shots";
    const { runId } = seedFullTest(id);
    const runDir = artifactStore.runDir(id, runId);
    expect(fs.existsSync(path.join(runDir, "0.png"))).toBe(true);

    await invokeHandler("tests:delete", { id });

    expect(fs.existsSync(runDir)).toBe(false);
  });

  it("removes the raw run log from disk", async () => {
    // The log is the one artifact here that quotes the site — page content,
    // URLs, values typed during recording.
    const id = "t-del-log";
    const { runId } = seedFullTest(id);
    const logFile = runHistoryStore.list().find((r) => r.id === runId)!.logFile;
    expect(fs.existsSync(logFile)).toBe(true);

    await invokeHandler("tests:delete", { id });

    expect(fs.existsSync(logFile)).toBe(false);
  });

  it("removes step annotations", async () => {
    const id = "t-del-notes";
    const { runId } = seedFullTest(id);

    await invokeHandler("tests:delete", { id });

    expect(annotationStore.list(id, runId)).toEqual([]);
  });

  it("removes the heal journal entries", async () => {
    const id = "t-del-heals";
    seedFullTest(id);

    await invokeHandler("tests:delete", { id });

    expect(healJournalStore.list(id)).toEqual([]);
  });

  it("removes the AI debug sessions", async () => {
    // Their content is the model quoting the script and the run output, and
    // with the test gone there is no route left in the UI to reach or remove
    // them.
    const id = "t-del-ai";
    seedFullTest(id);
    expect(aiDebugStore.get(`run:${id}`)).not.toBeNull();

    await invokeHandler("tests:delete", { id });

    expect(aiDebugStore.get(`run:${id}`)).toBeNull();
    expect(aiDebugStore.list().filter((s) => s.testId === id)).toEqual([]);
  });

  it("records an AI debug attempt through the IPC boundary", async () => {
    // The channel exists, is registered, and rebuilds the record rather than
    // storing what it was handed — the property that keeps the model's answer
    // out of a store whose whole premise is that it holds none.
    await invokeHandler("aiDebug:record", {
      record: {
        id: "ipc-1",
        key: "run:t-ipc",
        kind: "run",
        testId: "t-ipc",
        testName: "Alpha",
        trigger: "manual",
        provider: "anthropic",
        model: "claude",
        status: "done",
        startedAt: 5,
        endedAt: 10,
        firstTokenMs: 2,
        promptChars: 100,
        answerChars: 50,
        runKey: null,
        content: "the model's answer",
      },
    });

    const rows = await invokeHandler<Array<Record<string, unknown>>>("aiDebug:history");
    const row = rows.find((r) => r.id === "ipc-1")!;
    expect(row).toBeTruthy();
    expect(row.provider).toBe("anthropic");
    expect(Object.keys(row)).not.toContain("content");
  });

  it("clears the sessions AND the history together", async () => {
    // "Delete AI debug history…" means what it says: a user asking for that
    // does not expect a shadow index of what they deleted to survive.
    await invokeHandler("aiDebug:record", {
      record: {
        id: "clear-1",
        key: "run:t-clear",
        kind: "run",
        testId: "t-clear",
        testName: "Alpha",
        trigger: "manual",
        provider: "ollama",
        model: "qwen",
        status: "done",
        startedAt: 1,
        endedAt: 2,
        firstTokenMs: null,
        promptChars: 0,
        answerChars: 0,
        runKey: null,
      },
    });

    const res = await invokeHandler<{ removed: number; historyRemoved: number }>("aiDebug:clear");

    expect(res.historyRemoved).toBeGreaterThan(0);
    expect(aiDebugHistoryStore.list()).toEqual([]);
  });

  it("TOMBSTONES the AI debug history rather than deleting it", async () => {
    // The opposite of the sessions above, and deliberately: a history row holds
    // no quotes, only the fact that a diagnosis happened and what it cost.
    // Deleting it would make every lifetime total on the Stats board walk
    // backwards the moment a test is removed.
    const id = "t-del-ai-history";
    seedFullTest(id);
    await invokeHandler("aiDebug:record", {
      record: {
        id: `run:${id}@1`,
        key: `run:${id}`,
        kind: "run",
        testId: id,
        testName: "Checkout",
        trigger: "manual",
        provider: "ollama",
        model: "qwen",
        status: "done",
        startedAt: 1,
        endedAt: 2,
        firstTokenMs: 1,
        promptChars: 10,
        answerChars: 10,
        runKey: null,
      },
    });

    await invokeHandler("tests:delete", { id });

    const rows = aiDebugHistoryStore.list().filter((r) => r.testId === id);
    expect(rows).toHaveLength(1);
    expect(rows[0].testDeleted).toBe(true);
    // And it can still name the test it belonged to, or no panel could list it.
    expect(rows[0].testName).toBe("Checkout");
  });

  it("removes the recorder debug logs", async () => {
    const id = "t-del-debug";
    seedFullTest(id);
    expect(recorderDebugStore.get(id).length).toBe(1);

    await invokeHandler("tests:delete", { id });

    expect(recorderDebugStore.get(id)).toEqual([]);
  });

  it("drops the test from the Batch view's stored order and row options", async () => {
    const id = "t-del-batchopts";
    seedFullTest(id);

    await invokeHandler("tests:delete", { id });

    const settings = recorderSettingsStore.get();
    expect(settings.batchOrder).not.toContain(id);
    expect(id in settings.batchTestOptions).toBe(false);
    // And leaves everyone else's entries alone.
    expect(settings.batchOrder).toContain("someone-else");
    expect(settings.batchTestOptions["someone-else"]).toBeTruthy();
  });

  it("strips the test's NAME from the run history it leaves behind", async () => {
    // The records survive for the aggregates, but the name is the identifying
    // leftover — the only thing in run-history.json a person would recognise.
    const id = "t-del-name";
    seedFullTest(id);

    await invokeHandler("tests:delete", { id });

    const orphans = runHistoryStore.list().filter((r) => r.testId === id);
    expect(orphans.length).toBeGreaterThan(0);
    for (const r of orphans) {
      expect(r.testDeleted).toBe(true);
      expect(r.testName).toBe(DELETED_TEST_NAME);
    }
  });

  it("strips the test's name from stored batch history too", async () => {
    const id = "t-del-batchname";
    seedFullTest(id);

    await invokeHandler("tests:delete", { id });

    const batch = batchHistoryStore.get(`b-${id}`)!;
    // The row stays, so the batch's own summary still adds up to its rows.
    expect(batch.results).toHaveLength(1);
    expect(batch.summary.total).toBe(1);
    expect(batch.results[0].testDeleted).toBe(true);
    expect(batch.results[0].testName).toBe(DELETED_TEST_NAME);
  });

  it("KEEPS the run records, so the pass rate does not move", async () => {
    // The whole trade-off, in one assertion. Pass rate, the daily chart and the
    // capture-overhead figures answer "what has this machine done" — having
    // them rewrite history on a delete is what makes people stop trusting them.
    const id = "t-del-passrate";
    seedFullTest(id);
    const before = runHistoryStore.list();
    const rate = (rs: typeof before) =>
      rs.filter((r) => r.status === "passed").length / Math.max(1, rs.length);
    const rateBefore = rate(before);

    await invokeHandler("tests:delete", { id });

    const after = runHistoryStore.list();
    expect(after.length).toBe(before.length);
    expect(rate(after)).toBe(rateBefore);
  });

  it("hides those runs from everything that names a test", async () => {
    const id = "t-del-hidden";
    seedFullTest(id);

    await invokeHandler("tests:delete", { id });

    // listLive is what the run table, the test filter and Stability read.
    expect(runHistoryStore.listLive().some((r) => r.testId === id)).toBe(false);
    // And the log search, which searches by content and reports by name.
    expect(runHistoryStore.searchLogs("quotes the page").some((r) => r.runId === id)).toBe(false);
  });

  it("keeps another test's runs, artifacts and options untouched", async () => {
    // The scariest failure mode of a delete-everything change is over-reach.
    const victim = "t-del-victim";
    const bystander = "t-del-bystander";
    seedFullTest(victim);
    const { runId: keptRun } = seedFullTest(bystander);

    await invokeHandler("tests:delete", { id: victim });

    expect(testStore.get(bystander)).not.toBeNull();
    expect(runHistoryStore.listLive().some((r) => r.testId === bystander)).toBe(true);
    expect(fs.existsSync(artifactStore.runDir(bystander, keptRun))).toBe(true);
    expect(aiDebugStore.get(`run:${bystander}`)).not.toBeNull();
    expect(healJournalStore.list(bystander).length).toBe(1);
  });

  it("gives a re-imported test a clean slate rather than the old one's ghost", async () => {
    // Ids are not reused in practice, but the tombstones must not resurrect if
    // one ever is — an inherited verdict nobody remembers making is worse than
    // no history at all.
    const id = "t-del-reimport";
    seedFullTest(id);
    await invokeHandler("tests:delete", { id });

    seedTest(id);

    expect(healJournalStore.list(id)).toEqual([]);
    expect(recorderDebugStore.get(id)).toEqual([]);
    expect(aiDebugStore.list().filter((s) => s.testId === id)).toEqual([]);
    expect(runHistoryStore.listLive().some((r) => r.testId === id)).toBe(false);
  });

  it("is idempotent — deleting twice is not an error", async () => {
    const id = "t-del-twice";
    seedFullTest(id);

    await invokeHandler("tests:delete", { id });
    await expect(invokeHandler("tests:delete", { id })).resolves.toBeUndefined();
  });

  it("does not throw for an id that never existed", async () => {
    await expect(invokeHandler("tests:delete", { id: "never-was" })).resolves.toBeUndefined();
  });
});

describe("the script-change journal — recording a whole-spec change, and undoing it", () => {
  /** Seed a test with a script actually on disk. */
  function seedWithScript(id: string, source: string): TestRecord {
    const rec = seedTest(id);
    rec.scriptPath = testStore.writeScript(id, source);
    testStore.save(rec);
    return rec;
  }

  const ORIGINAL =
    "import { test } from '@playwright/test';\ntest('a', async ({ page }) => {});\n";
  const FIXED = "import { test } from '@playwright/test';\ntest('b', async ({ page }) => {});\n";

  it("records the previous script, which is the only copy of it that survives", async () => {
    // `tests:updateScript` overwrites the file and re-parses the steps, so
    // after this call the old spec exists nowhere else on disk.
    const rec = seedWithScript("t-sc-record", ORIGINAL);
    await invokeHandler("tests:updateScript", { id: rec.id, source: FIXED });

    const [entry] = scriptChangeStore.list(rec.id);
    expect(entry.before).toBe(ORIGINAL);
    expect(entry.after).toBe(FIXED);
  });

  it("treats a caller that says nothing as a manual edit the user watched land", async () => {
    // Every call site predating the journal passes no origin, and none of them
    // should start filling the review queue.
    const rec = seedWithScript("t-sc-default", ORIGINAL);
    await invokeHandler("tests:updateScript", { id: rec.id, source: FIXED });

    const [entry] = scriptChangeStore.list(rec.id);
    expect(entry.origin).toBe("manual");
    expect(entry.reviewed).toBe(true);
    expect(entry.status).toBe("accepted");
  });

  it("queues an AI fix nobody saw land, and settles one that was read first", async () => {
    const auto = seedWithScript("t-sc-auto", ORIGINAL);
    await invokeHandler("tests:updateScript", {
      id: auto.id,
      source: FIXED,
      origin: { by: "ai-debug", model: "claude-sonnet-4", reviewed: false },
    });
    const read = seedWithScript("t-sc-read", ORIGINAL);
    await invokeHandler("tests:updateScript", {
      id: read.id,
      source: FIXED,
      origin: { by: "ai-debug", model: "claude-sonnet-4", reviewed: true },
    });

    expect(scriptChangeStore.list(auto.id)[0]).toMatchObject({
      origin: "ai-debug",
      model: "claude-sonnet-4",
      status: "pending",
    });
    expect(scriptChangeStore.list(read.id)[0].status).toBe("accepted");
  });

  it("rebuilds a hostile origin rather than filtering it", async () => {
    const rec = seedWithScript("t-sc-hostile", ORIGINAL);
    await invokeHandler("tests:updateScript", {
      id: rec.id,
      source: FIXED,
      origin: {
        by: "<script>alert(1)</script>",
        model: "evil",
        reviewed: "no",
        // Unknown keys must not survive into the stored entry, or the next
        // field wired into a row is a hole again.
        status: "accepted",
        truncated: true,
      },
    });

    const [entry] = scriptChangeStore.list(rec.id);
    expect(entry.origin).toBe("manual");
    // A model is only kept for an ai-debug change, and this one isn't.
    expect(entry.model).toBeUndefined();
    // "no" is not `false`, so it does not mean unreviewed.
    expect(entry.reviewed).toBe(true);
    expect(entry.truncated).toBeUndefined();
  });

  it("strips control characters from a model name and caps its length", async () => {
    const rec = seedWithScript("t-sc-model", ORIGINAL);
    await invokeHandler("tests:updateScript", {
      id: rec.id,
      source: FIXED,
      origin: { by: "ai-debug", model: `a\u0000b\u001b[31m${"z".repeat(200)}`, reviewed: true },
    });

    const model = scriptChangeStore.list(rec.id)[0].model ?? "";
    // Asserted by codepoint rather than by regex: a character class of literal
    // control characters is exactly what `no-control-regex` exists to stop.
    const control = [...model].filter((c) => {
      const code = c.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    });
    expect(control).toEqual([]);
    expect(model.length).toBeLessThanOrEqual(80);
  });

  it("records nothing when the save did not change the script", async () => {
    const rec = seedWithScript("t-sc-noop", ORIGINAL);
    await invokeHandler("tests:updateScript", { id: rec.id, source: ORIGINAL });

    expect(scriptChangeStore.list(rec.id)).toEqual([]);
  });

  it("reverts by writing the previous spec back and re-parsing its steps", async () => {
    const rec = seedWithScript(
      "t-sc-revert",
      "import { test, expect } from '@playwright/test';\n" +
        "test('t', async ({ page }) => {\n  await page.goto('https://before.test/');\n});\n",
    );
    await invokeHandler("tests:updateScript", {
      id: rec.id,
      source:
        "import { test, expect } from '@playwright/test';\n" +
        "test('t', async ({ page }) => {\n  await page.goto('https://after.test/');\n});\n",
      origin: { by: "ai-debug", model: "m", reviewed: false },
    });
    expect(testStore.get(rec.id)?.steps[0]).toMatchObject({ url: "https://after.test/" });

    const [entry] = scriptChangeStore.list(rec.id);
    await invokeHandler("scriptChanges:revert", { id: entry.id });

    expect(testStore.readScript(rec.id)).toContain("https://before.test/");
    // The step list has to come back too. A revert that restores the file but
    // leaves the Steps tab describing the fix reads as a control that half
    // worked, and nothing would report it.
    expect(testStore.get(rec.id)?.steps[0]).toMatchObject({ url: "https://before.test/" });
    expect(scriptChangeStore.get(entry.id)?.status).toBe("reverted");
  });

  it("does not journal the revert itself", async () => {
    // Otherwise every undo leaves a new entry to undo, and the list grows by
    // one each time the user puts something back.
    const rec = seedWithScript("t-sc-revert-once", ORIGINAL);
    await invokeHandler("tests:updateScript", { id: rec.id, source: FIXED });
    const [entry] = scriptChangeStore.list(rec.id);

    await invokeHandler("scriptChanges:revert", { id: entry.id });

    expect(scriptChangeStore.list(rec.id)).toHaveLength(1);
  });

  it("refuses to revert an entry whose sources were too large to keep", async () => {
    // `before` is empty on one of these, so a revert that went ahead would
    // write an empty spec over a working test.
    const rec = seedWithScript("t-sc-truncated", ORIGINAL);
    const entry = scriptChangeStore.record({
      testId: rec.id,
      origin: "manual",
      reviewed: true,
      before: "x".repeat(MAX_SOURCE_BYTES + 1),
      after: FIXED,
    })!;

    await expect(invokeHandler("scriptChanges:revert", { id: entry.id })).rejects.toThrow();
    expect(testStore.readScript(rec.id)).toBe(ORIGINAL);
  });

  it("accepts without touching the script — it was already written", async () => {
    const rec = seedWithScript("t-sc-accept", ORIGINAL);
    await invokeHandler("tests:updateScript", {
      id: rec.id,
      source: FIXED,
      origin: { by: "ai-debug", model: "m", reviewed: false },
    });
    const [entry] = scriptChangeStore.list(rec.id);

    await invokeHandler("scriptChanges:accept", { id: entry.id });

    expect(scriptChangeStore.get(entry.id)?.status).toBe("accepted");
    expect(testStore.readScript(rec.id)).toBe(FIXED);
  });

  it("throws for an unknown id rather than reporting success", async () => {
    await expect(invokeHandler("scriptChanges:revert", { id: "nope" })).rejects.toThrow();
    await expect(invokeHandler("scriptChanges:accept", { id: "nope" })).rejects.toThrow();
  });

  it("attaches the test name for the cross-test view, and drops the lot on delete", async () => {
    const rec = seedWithScript("t-sc-named", ORIGINAL);
    await invokeHandler("tests:updateScript", { id: rec.id, source: FIXED });

    const listed = await invokeHandler<Array<{ testId: string; testName: string | null }>>(
      "scriptChanges:listAll",
    );
    expect(listed.find((e) => e.testId === rec.id)?.testName).toBe(rec.name);

    await invokeHandler("tests:delete", { id: rec.id });
    const after = await invokeHandler<Array<{ testId: string }>>("scriptChanges:listAll");
    // Deleting the test takes its journal with it, for the same reason the heal
    // journal goes: nothing is left that could act on the entry.
    expect(after.some((e) => e.testId === rec.id)).toBe(false);
  });
});
