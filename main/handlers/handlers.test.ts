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
} from "../services/__tests__/glaze-backend-stub.js";
import { registerHandlers } from "./index.js";
import { testStore } from "../services/test-store.js";
import type { TestRecord } from "../recorder/types.js";

// Safe to set after the imports: the stub resolves app.getPath() lazily on
// every call (deliberately, so tests can point userData at a temp dir), and
// nothing here touches disk at import time.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-handlers-test-"));
process.env.GLAZE_TEST_USERDATA = userData;

function seedTest(id: string): TestRecord {
  const rec: TestRecord = {
    id,
    name: `Test ${id}`,
    url: "https://example.com",
    createdAt: 1,
    updatedAt: 1,
    steps: [],
    scriptPath: path.join(userData, "recorder", "scripts", `${id}.spec.ts`),
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
      "tests:setBrowser",
      "tests:setHeadless",
      "runner:run",
      "runner:stop",
      "batch:run",
      "batch:stop",
      "batch:list",
      "alerts:setWebhookUrl",
      "alerts:status",
      "recorder:listCookies",
      "recorder:setCookie",
      "recorder:getSettings",
      "runs:list",
    ]) {
      expect(channels.has(c), `missing channel: ${c}`).toBe(true);
    }
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
