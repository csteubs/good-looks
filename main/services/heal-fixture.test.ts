// Tests for run-time Auto-Heal.
//
// The fixture runs inside the Playwright child process, so none of it is
// reachable from the app's own code paths. It is loaded here the same way
// Playwright loads it — written to disk as a real .mjs and imported — and
// driven against a fake `page` that fails the way Playwright fails.
//
// What's worth guarding, in order of how quietly it would break:
//
//   1. The locator KEY. The fixture tags locators with a key and the runner
//      builds a map under the same key. Nothing errors if those two spellings
//      drift — every lookup just misses, and healing stops happening with no
//      symptom at all. That test compares the two implementations directly.
//   2. Rethrowing untouched. A failure healing can't address must reach the
//      test as itself, or a genuine app bug gets reported as a heal that didn't
//      work.
//   3. Not healing what wasn't recorded. A locator with no map entry must not
//      be "healed" into something arbitrary.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

import { healFixtureSource } from "./heal-fixture-source.js";
import { healKeyFor } from "./playwright-runner.js";
import type { Locator } from "../recorder/types.js";

let dir: string;
let healDir: string;

/** A fake page whose locators behave the way Playwright's do in the two ways
 *  the fixture depends on: actions live on a shared PROTOTYPE, and a failing
 *  one throws.
 *
 *  Built fresh per test — as a class created inside the factory, not a shared
 *  one — because `installHealing` mutates that prototype. A single class shared
 *  across tests gets wrapped once per install, and every later test then runs
 *  through the first test's closure (and its probe results). That cost a
 *  confusing round of debugging here; keeping the class local makes it
 *  impossible. */
interface FakePage {
  failures: Map<string, string>;
  performed: string[];
  probeResult: { locator: Locator }[];
  evaluatedProbes: string[];
  evaluate(source: string): Promise<unknown>;
  getByTestId(v: string): { click(): Promise<string>; fill(v: string): Promise<string> };
  getByLabel(v: string): { click(): Promise<string>; fill(v: string): Promise<string> };
  getByPlaceholder(v: string): { click(): Promise<string> };
  getByText(v: string): { click(): Promise<string> };
  getByRole(role: string, opts?: { name?: string }): { click(): Promise<string> };
  locator(v: string): { click(): Promise<string> };
}

function makePage(): FakePage {
  // Every closure below reads through `page`, never through a captured copy.
  // An earlier version spread the state into the object, so a test assigning
  // `page.probeResult = [...]` replaced the page's property while `evaluate`
  // kept returning the original empty array — the probe silently found nothing
  // and the heal never happened.
  const page = {
    failures: new Map<string, string>(),
    performed: [] as string[],
    probeResult: [] as { locator: Locator }[],
    evaluatedProbes: [] as string[],
  } as FakePage;

  function act(desc: string, what: string): string {
    const failure = page.failures.get(desc);
    if (failure) throw new Error(failure);
    page.performed.push(`${desc}:${what}`);
    return `${desc}:${what}`;
  }

  class FakeLocator {
    constructor(public readonly desc: string) {}
    async click(): Promise<string> {
      return act(this.desc, "click");
    }
    async fill(value: string): Promise<string> {
      return act(this.desc, `fill:${value}`);
    }
  }

  page.evaluate = async (source: string) => {
    page.evaluatedProbes.push(source);
    return page.probeResult;
  };
  page.getByTestId = (v: string) => new FakeLocator(`testid=${v}`);
  page.getByLabel = (v: string) => new FakeLocator(`label=${v}`);
  page.getByPlaceholder = (v: string) => new FakeLocator(`placeholder=${v}`);
  page.getByText = (v: string) => new FakeLocator(`text=${v}`);
  page.getByRole = (role: string, opts?: { name?: string }) =>
    new FakeLocator(`role=${role}/${opts?.name ?? ""}`);
  page.locator = (v: string) => new FakeLocator(`css=${v}`);
  return page;
}

type HealModule = { installHealing: (page: unknown) => void };

async function loadFixture(map: Record<string, unknown>): Promise<HealModule> {
  const mapFile = path.join(dir, "heal-map.json");
  fs.writeFileSync(mapFile, JSON.stringify(map), "utf-8");
  process.env.GLAZE_HEAL_DIR = healDir;
  process.env.GLAZE_HEAL_MAP = mapFile;
  // A fresh filename per load: ESM modules are cached by URL, and the fixture
  // reads its map once at module scope.
  const file = path.join(dir, `glaze-heal-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, healFixtureSource, "utf-8");
  return (await import(pathToFileURL(file).href)) as HealModule;
}

function entry(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stepId: "s1",
    stepIndex: 0,
    stepLabel: 'getByTestId("submit").click()',
    locator: { k: "testid", v: "submit" },
    probe: "(function(){ return []; })()",
    ...partial,
  };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-heal-fixture-"));
  healDir = path.join(dir, "heals");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.GLAZE_HEAL_DIR;
  delete process.env.GLAZE_HEAL_MAP;
});

describe("heal key agreement", () => {
  // The runner and the fixture each build the key independently. If they ever
  // disagree, the map lookup misses and run-time healing silently stops — no
  // error, no log line, nothing to notice. This compares them directly.
  const cases: { loc: Locator; expected: string }[] = [
    { loc: { k: "testid", v: "submit" }, expected: "testid|submit" },
    { loc: { k: "label", v: "Email" }, expected: "label|Email" },
    { loc: { k: "placeholder", v: "Search" }, expected: "placeholder|Search" },
    { loc: { k: "text", v: "Log in" }, expected: "text|Log in" },
    { loc: { k: "role", role: "button", name: "Save" }, expected: "role|button|Save" },
    { loc: { k: "role", role: "button" }, expected: "role|button|" },
    { loc: { k: "css", v: "#main .btn" }, expected: "css|#main .btn" },
  ];

  it.each(cases)("runner builds $expected", ({ loc, expected }) => {
    expect(healKeyFor(loc)).toBe(expected);
  });

  it("the fixture derives the SAME key the runner does", () => {
    // The real cross-check: pull the fixture's own FACTORIES table out of its
    // source, run it, and compare against healKeyFor. Asserting healKeyFor
    // against hardcoded strings would pass forever while the fixture's half
    // drifted away underneath it — and a drifted key produces no error at all,
    // just healing that silently never fires.
    const m = healFixtureSource.match(/const FACTORIES = \{[\s\S]*?\n\};/);
    expect(m, "FACTORIES table not found in the fixture source").toBeTruthy();
    const factories = eval(`(${m![0].replace(/^const FACTORIES = /, "").replace(/;$/, "")})`) as Record<
      string,
      (args: unknown[]) => string
    >;

    // Each locator kind, as the runner keys it and as the fixture would tag it.
    const pairs: { loc: Locator; factory: string; args: unknown[] }[] = [
      { loc: { k: "testid", v: "submit" }, factory: "getByTestId", args: ["submit"] },
      { loc: { k: "label", v: "Email" }, factory: "getByLabel", args: ["Email"] },
      { loc: { k: "placeholder", v: "Search" }, factory: "getByPlaceholder", args: ["Search"] },
      { loc: { k: "text", v: "Log in" }, factory: "getByText", args: ["Log in"] },
      {
        loc: { k: "role", role: "button", name: "Save" },
        factory: "getByRole",
        args: ["button", { name: "Save" }],
      },
      { loc: { k: "role", role: "button" }, factory: "getByRole", args: ["button", undefined] },
      { loc: { k: "css", v: "#main .btn" }, factory: "locator", args: ["#main .btn"] },
      { loc: { k: "xpath", v: "//button" }, factory: "locator", args: ["xpath=//button"] },
    ];

    for (const { loc, factory, args } of pairs) {
      expect(factories[factory], `${factory} is not patched by the fixture`).toBeTypeOf("function");
      expect(factories[factory](args), `key mismatch for ${loc.k}`).toBe(healKeyFor(loc));
    }
  });
});

describe("installHealing", () => {
  it("heals a failing action and retries with the proposed locator", async () => {
    const mod = await loadFixture({
      "testid|submit": entry({ probe: "(function(){ return PROBE; })()" }),
    });
    const page = makePage();
    page.failures.set("testid=submit", "Timeout 30000ms exceeded waiting for locator");
    page.probeResult = [{ locator: { k: "role", role: "button", name: "Place order" } }];
    mod.installHealing(page);

    const result = await page.getByTestId("submit").click();

    expect(result).toBe("role=button/Place order:click");
    expect(page.performed).toEqual(["role=button/Place order:click"]);
  });

  it("writes the heal to heals.json for the runner to journal", async () => {
    fs.rmSync(healDir, { recursive: true, force: true });
    const mod = await loadFixture({ "testid|submit": entry() });
    const page = makePage();
    page.failures.set("testid=submit", "Timeout 30000ms exceeded waiting for locator");
    page.probeResult = [{ locator: { k: "testid", v: "submit-v2" } }];
    mod.installHealing(page);

    await page.getByTestId("submit").click();

    const written = JSON.parse(fs.readFileSync(path.join(healDir, "heals.json"), "utf-8"));
    expect(written).toHaveLength(1);
    expect(written[0].stepId).toBe("s1");
    // Both sides are recorded: without the original there is no undo.
    expect(written[0].originalLocator).toEqual({ k: "testid", v: "submit" });
    expect(written[0].appliedLocator).toEqual({ k: "testid", v: "submit-v2" });
  });

  it("rethrows a failure healing cannot address, untouched", async () => {
    // An assertion that resolved its element and found the wrong value is an
    // app bug. Dressing it up as a failed heal would bury the real message.
    const mod = await loadFixture({ "testid|submit": entry() });
    const page = makePage();
    page.failures.set("testid=submit", "Element is not a checkbox");
    page.probeResult = [{ locator: { k: "testid", v: "other" } }];
    mod.installHealing(page);

    await expect(page.getByTestId("submit").click()).rejects.toThrow("Element is not a checkbox");
    expect(page.evaluatedProbes).toHaveLength(0);
  });

  it("does not heal a locator that has no recorded entry", async () => {
    const mod = await loadFixture({ "testid|other": entry() });
    const page = makePage();
    page.failures.set("testid=submit", "Timeout 30000ms exceeded waiting for locator");
    page.probeResult = [{ locator: { k: "testid", v: "anything" } }];
    mod.installHealing(page);

    await expect(page.getByTestId("submit").click()).rejects.toThrow("Timeout");
    expect(page.evaluatedProbes).toHaveLength(0);
  });

  it("moves on when the best candidate also fails", async () => {
    // One bad suggestion must not cost the run. The second candidate is tried.
    const mod = await loadFixture({ "testid|submit": entry() });
    const page = makePage();
    page.failures.set("testid=submit", "Timeout 30000ms exceeded waiting for locator");
    page.failures.set("testid=bad", "Timeout 30000ms exceeded waiting for locator");
    page.probeResult = [
      { locator: { k: "testid", v: "bad" } },
      { locator: { k: "testid", v: "good" } },
    ];
    mod.installHealing(page);

    const result = await page.getByTestId("submit").click();
    expect(result).toBe("testid=good:click");
  });

  it("rethrows the ORIGINAL error when no candidate works", async () => {
    const mod = await loadFixture({ "testid|submit": entry() });
    const page = makePage();
    page.failures.set("testid=submit", "Timeout 30000ms exceeded waiting for locator");
    page.failures.set("testid=bad", "Timeout 30000ms exceeded waiting for locator");
    page.probeResult = [{ locator: { k: "testid", v: "bad" } }];
    mod.installHealing(page);

    await expect(page.getByTestId("submit").click()).rejects.toThrow("Timeout 30000ms");
  });

  it("leaves a passing action completely alone", async () => {
    const mod = await loadFixture({ "testid|submit": entry() });
    const page = makePage();
    mod.installHealing(page);

    const result = await page.getByTestId("submit").click();
    expect(result).toBe("testid=submit:click");
    expect(page.evaluatedProbes).toHaveLength(0);
  });

  it("passes the action's own arguments through to the healed locator", async () => {
    // A healed `fill` must still type the value it was given. Dropping the
    // arguments would leave a filled-looking step that typed nothing.
    const mod = await loadFixture({
      "label|Email": entry({ locator: { k: "label", v: "Email" } }),
    });
    const page = makePage();
    page.failures.set("label=Email", "Timeout 30000ms exceeded waiting for locator");
    page.probeResult = [{ locator: { k: "testid", v: "email-input" } }];
    mod.installHealing(page);

    const result = await page.getByLabel("Email").fill("a@b.com");
    expect(result).toBe("testid=email-input:fill:a@b.com");
  });
});
