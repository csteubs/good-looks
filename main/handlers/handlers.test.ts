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
import { registerHandlers } from "./index.js";
import { testStore } from "../services/test-store.js";
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
