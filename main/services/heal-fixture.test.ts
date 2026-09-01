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

import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

import { healFixtureSource } from "../../shared/heal-fixture-source.mjs";
import { healKeyFor } from "../../shared/heal-key.mjs";
import { healKeyOperatorSource } from "../../shared/heal-key.mjs";
import { testIdSelector } from "../../shared/testid-attr.mjs";
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
/** Enough of an Element for the fixture's page-side describe function to walk.
 *  Deliberately a real object graph rather than a stub return value: the
 *  descriptor builder runs INSIDE the page, so it is the one part of this
 *  fixture no other test can reach, and handing it a canned answer would test
 *  the plumbing around logic that had never run. */
interface FakeElement {
  tagName: string;
  id: string;
  className: string;
  textContent: string;
  disabled: boolean;
  attrs: Record<string, string>;
  parentElement: FakeElement | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
}

interface FakePage {
  failures: Map<string, string>;
  performed: string[];
  probeResult: { locator: Locator }[];
  evaluatedProbes: string[];
  /** what a failing locator resolves to, for `evaluateAll` */
  matchElements: FakeElement[];
  /** what `locator.page().url()` answers; null = no URL to give */
  pageUrl: string | null;
  /** make `url()` throw, the way a torn-down page does */
  urlThrows: boolean;
  /** what `viewportSize()` answers; null = no viewport set */
  viewport: { width: number; height: number } | null;
  /** per-locator `boundingBox()` answers, keyed by the fake's desc; a locator
   *  with no entry throws, the degraded path the fixture must survive */
  boxes: Map<string, { x: number; y: number; width: number; height: number }>;
  viewportSize(): { width: number; height: number } | null;
  evaluate(source: string): Promise<unknown>;
  getByTestId(v: string): FakeLoc;
  getByLabel(v: string): FakeLoc;
  getByPlaceholder(v: string): FakeLoc;
  getByText(v: string): FakeLoc;
  getByRole(role: string, opts?: { name?: string }): FakeLoc;
  locator(v: string): FakeLoc;
}

/** What the fake page's factories return.
 *
 *  Carries the locator-level BUILDERS and refiners as well as the actions,
 *  because an element-context step reaches its action through a chain
 *  (`page.getByTestId(…).filter(…).getByRole(…).and(…)`) and the fixture has to
 *  patch every link in it. A stub typed to actions alone could not express the
 *  case at all. */
interface FakeLoc {
  click(): Promise<string>;
  fill(v: string): Promise<string>;
  getByTestId(v: string): FakeLoc;
  getByLabel(v: string): FakeLoc;
  getByPlaceholder(v: string): FakeLoc;
  getByText(v: string): FakeLoc;
  getByRole(role: string, opts?: { name?: string }): FakeLoc;
  locator(v: string): FakeLoc;
  filter(opts: { hasText?: string }): FakeLoc;
  and(other: FakeLoc): FakeLoc;
  nth(i: number): FakeLoc;
  page(): { url(): string | null };
  boundingBox(opts?: {
    timeout?: number;
  }): Promise<{ x: number; y: number; width: number; height: number }>;
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
    matchElements: [] as FakeElement[],
    pageUrl: "https://shop.example.test/checkout?step=2" as string | null,
    urlThrows: false,
    viewport: { width: 1000, height: 500 } as { width: number; height: number } | null,
    boxes: new Map<string, { x: number; y: number; width: number; height: number }>(),
  } as FakePage;
  page.viewportSize = () => page.viewport;

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
    async evaluateAll<T>(fn: (els: FakeElement[]) => T): Promise<T> {
      return fn(page.matchElements);
    }
    // Locator-level BUILDERS and the two refiners the app models. Real
    // Playwright has these on `Locator`, and the fixture has to patch them
    // there as well as on `Page` — an element-context step reaches its action
    // through `page.getByTestId(…).getByRole(…)`, so a stub with only the
    // page-level factories cannot tell whether that chain gets tagged.
    getByTestId(v: string): FakeLocator {
      return new FakeLocator(`${this.desc}>testid=${v}`);
    }
    getByLabel(v: string): FakeLocator {
      return new FakeLocator(`${this.desc}>label=${v}`);
    }
    getByPlaceholder(v: string): FakeLocator {
      return new FakeLocator(`${this.desc}>placeholder=${v}`);
    }
    getByText(v: string): FakeLocator {
      return new FakeLocator(`${this.desc}>text=${v}`);
    }
    getByRole(role: string, opts?: { name?: string }): FakeLocator {
      return new FakeLocator(`${this.desc}>role=${role}/${opts?.name ?? ""}`);
    }
    locator(v: string): FakeLocator {
      return new FakeLocator(`${this.desc}>css=${v}`);
    }
    filter(opts: { hasText?: string }): FakeLocator {
      return new FakeLocator(`${this.desc}[hasText=${opts?.hasText ?? ""}]`);
    }
    and(other: FakeLocator): FakeLocator {
      return new FakeLocator(`${this.desc}&${other.desc}`);
    }
    nth(i: number): FakeLocator {
      return new FakeLocator(`${this.desc}#${i}`);
    }
    // Real Playwright locators answer their owning page; `safeUrl` in the
    // fixture reads the URL through this rather than through the install-time
    // page, so a popup's locator reports the popup's address.
    page(): { url(): string | null } {
      return {
        url: () => {
          if (page.urlThrows) throw new Error("page has been closed");
          return page.pageUrl;
        },
      };
    }
    async boundingBox(_opts?: {
      timeout?: number;
    }): Promise<{ x: number; y: number; width: number; height: number }> {
      const box = page.boxes.get(this.desc);
      if (!box) throw new Error("boundingBox unavailable");
      page.performed.push(`${this.desc}:boundingBox`);
      return box;
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
    // A testid on a non-default attribute is emitted as `locator("[…]")`, so
    // its key is the css key of that selector — the run-time fixture only ever
    // sees the `locator` factory for it.
    {
      loc: { k: "testid", attr: "data-test-id", v: "submit" },
      expected: 'css|[data-test-id="submit"]',
    },
    { loc: { k: "testid", attr: "data-test", v: "submit" }, expected: 'css|[data-test="submit"]' },
    { loc: { k: "label", v: "Email" }, expected: "label|Email" },
    { loc: { k: "placeholder", v: "Search" }, expected: "placeholder|Search" },
    { loc: { k: "text", v: "Log in" }, expected: "text|Log in" },
    // Two locators, two keys: a heal recorded for the substring form must not
    // apply to the exact one, which resolves a different set.
    { loc: { k: "text", v: "Log in", exact: true }, expected: "text!|Log in" },
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
    // The table calls the shared key operators (healKeyText), which the
    // fixture embeds as source — so they are embedded here the same way.
    const factories = eval(
      `${healKeyOperatorSource()}; (${m![0].replace(/^const FACTORIES = /, "").replace(/;$/, "")})`,
    ) as Record<string, (args: unknown[]) => string>;

    // Each locator kind, as the runner keys it and as the fixture would tag it.
    const pairs: { loc: Locator; factory: string; args: unknown[] }[] = [
      { loc: { k: "testid", v: "submit" }, factory: "getByTestId", args: ["submit"] },
      { loc: { k: "label", v: "Email" }, factory: "getByLabel", args: ["Email"] },
      { loc: { k: "placeholder", v: "Search" }, factory: "getByPlaceholder", args: ["Search"] },
      { loc: { k: "text", v: "Log in" }, factory: "getByText", args: ["Log in"] },
      { loc: { k: "text", v: "Log in", exact: true }, factory: "getByText", args: ["Log in", { exact: true }] },
      {
        loc: { k: "role", role: "button", name: "Save" },
        factory: "getByRole",
        args: ["button", { name: "Save" }],
      },
      { loc: { k: "role", role: "button" }, factory: "getByRole", args: ["button", undefined] },
      { loc: { k: "css", v: "#main .btn" }, factory: "locator", args: ["#main .btn"] },
      { loc: { k: "xpath", v: "//button" }, factory: "locator", args: ["xpath=//button"] },
      // The generator emits a non-default-attribute testid through `locator()`,
      // and the argument the fixture sees is the selector exactly as
      // `testIdSelector` spelled it in the source.
      {
        loc: { k: "testid", attr: "data-test", v: "submit" },
        factory: "locator",
        args: [testIdSelector("data-test", "submit")],
      },
    ];

    for (const { loc, factory, args } of pairs) {
      expect(factories[factory], `${factory} is not patched by the fixture`).toBeTypeOf("function");
      expect(factories[factory](args), `key mismatch for ${loc.k}`).toBe(healKeyFor(loc));
    }
  });

  // ── Element context: the key is now COMPOSED, and both sides compose it ───
  //
  // Before context a key came from one factory call, so the two halves were a
  // flat switch and drift meant a misspelling. A context-carrying locator is a
  // CHAIN — container, optional text filter, target, then any `and` predicates
  // — so the key has an ORDER and a set of separators, which is a grammar. The
  // operators live in shared/heal-key.mjs and the fixture gets them as source;
  // these drive the REAL patched methods rather than re-deriving anything, so
  // they fail if either side stops agreeing.
  it("the fixture tags a chained locator with the composed key", async () => {
    const mod = await loadFixture({});
    const page = makePage();
    mod.installHealing(page);

    const loc = page
      .getByTestId("billing-card")
      .filter({ hasText: "Billing" })
      .getByRole("button", { name: "Edit" })
      .and(page.locator("[data-qa='edit']"));

    expect((loc as unknown as { __glazeKey?: string }).__glazeKey).toBe(
      healKeyFor({
        k: "role",
        role: "button",
        name: "Edit",
        ctx: {
          within: { k: "testid", v: "billing-card" },
          withinHasText: "Billing",
          and: [{ k: "css", v: "[data-qa='edit']" }],
        },
      }),
    );
  });

  it("a container alone composes the same key both ways", async () => {
    const mod = await loadFixture({});
    const page = makePage();
    mod.installHealing(page);

    const loc = page.getByTestId("card").getByRole("button", { name: "Edit" });
    expect((loc as unknown as { __glazeKey?: string }).__glazeKey).toBe(
      healKeyFor({
        k: "role",
        role: "button",
        name: "Edit",
        ctx: { within: { k: "testid", v: "card" } },
      }),
    );
  });

  it("an index still shares the key of the locator it narrows", async () => {
    // `.nth()` is a REFINER, not part of the identity: the key it propagates is
    // what makes an indexed step healable at all. Pinned here because the same
    // patch loop now CHANGES the key for two other refiners.
    const mod = await loadFixture({});
    const page = makePage();
    mod.installHealing(page);

    const plain = page.getByTestId("card").getByRole("button", { name: "Edit" });
    const indexed = plain.nth(2);
    expect((indexed as unknown as { __glazeKey?: string }).__glazeKey).toBe(
      (plain as unknown as { __glazeKey?: string }).__glazeKey,
    );
  });

  it("heals a step whose locator carries element context", async () => {
    // The regression this whole patch exists for. Only `page.*` factories were
    // wrapped, so a chained `.getByRole()` — a different function, on the
    // Locator prototype — returned an UNTAGGED locator and the action bailed on
    // its first line. Healing was silently off for every context step, which is
    // to say for exactly the steps a user had gone out of their way to
    // disambiguate.
    const key = healKeyFor({
      k: "role",
      role: "button",
      name: "Edit",
      ctx: { within: { k: "testid", v: "billing-card" } },
    });
    const mod = await loadFixture({ [key]: entry() });
    const page = makePage();
    page.failures.set(
      "testid=billing-card>role=button/Edit",
      "Timeout 30000ms exceeded waiting for locator",
    );
    page.probeResult = [{ locator: { k: "testid", v: "edit-v2" } }];
    mod.installHealing(page);

    const result = await page.getByTestId("billing-card").getByRole("button", { name: "Edit" }).click();
    expect(result).toBe("testid=edit-v2:click");
  });

  it("re-runs an applied heal through the context it was judged against", async () => {
    // Auto-Heal's candidates inherit the failing step's context, so the
    // substitute has to be REBUILT with it. Resolving the bare locator against
    // the whole page instead would raise the very strict-mode violation the
    // uniqueness gate exists to prevent — and it would do so having already
    // reported the step healed.
    const key = healKeyFor({
      k: "role",
      role: "button",
      name: "Edit",
      ctx: { within: { k: "testid", v: "billing-card" } },
    });
    const mod = await loadFixture({ [key]: entry() });
    const page = makePage();
    page.failures.set(
      "testid=billing-card>role=button/Edit",
      "Timeout 30000ms exceeded waiting for locator",
    );
    page.probeResult = [
      {
        locator: {
          k: "text",
          v: "Edit",
          ctx: { within: { k: "testid", v: "billing-card" } },
        },
      },
    ];
    mod.installHealing(page);

    const result = await page.getByTestId("billing-card").getByRole("button", { name: "Edit" }).click();
    // The chain, not the bare `text=Edit` — `fromModel` rebuilt the container.
    expect(result).toBe("testid=billing-card>text=Edit:click");
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

  // ── Recording what heals could NOT do ──────────────────────────────
  //
  // Until 2026-08-07 the fixture wrote an event only on success, so "Auto-Heal
  // tried and could not rescue this step" existed nowhere. It is the more
  // informative half: a step that healed says the locator went stale, a step
  // that could NOT be healed says the element is gone under every locator —
  // which points at the site rather than the test. Both cases below still fail
  // the run exactly as they did before; only the recording is new.

  it("records an EXHAUSTED attempt when every candidate also fails", async () => {
    fs.rmSync(healDir, { recursive: true, force: true });
    const mod = await loadFixture({ "testid|submit": entry() });
    const page = makePage();
    page.failures.set("testid=submit", "Timeout 30000ms exceeded waiting for locator");
    page.failures.set("testid=bad", "Timeout 30000ms exceeded waiting for locator");
    page.probeResult = [{ locator: { k: "testid", v: "bad" } }];
    mod.installHealing(page);

    await expect(page.getByTestId("submit").click()).rejects.toThrow("Timeout 30000ms");

    const written = JSON.parse(fs.readFileSync(path.join(healDir, "heals.json"), "utf-8"));
    expect(written).toHaveLength(1);
    expect(written[0].outcome).toBe("exhausted");
    expect(written[0].stepId).toBe("s1");
    // No applied locator: nothing was applied. A review row built from this
    // would have nothing to revert to, which is why the runner keeps these out
    // of the heal journal.
    expect(written[0].appliedLocator).toBeUndefined();
    // What WAS tried is kept — it's the evidence that the element could be
    // ranked but not acted on.
    expect(written[0].candidates).toEqual([{ locator: { k: "testid", v: "bad" } }]);
  });

  it("records a NO-CANDIDATES attempt when the probe ranks nothing", async () => {
    // The strongest single signal that the failure is the site's: a stale
    // locator still has something to rank, and this had nothing at all.
    fs.rmSync(healDir, { recursive: true, force: true });
    const mod = await loadFixture({ "testid|submit": entry() });
    const page = makePage();
    page.failures.set("testid=submit", "Timeout 30000ms exceeded waiting for locator");
    page.probeResult = [];
    mod.installHealing(page);

    await expect(page.getByTestId("submit").click()).rejects.toThrow("Timeout 30000ms");

    const written = JSON.parse(fs.readFileSync(path.join(healDir, "heals.json"), "utf-8"));
    expect(written).toHaveLength(1);
    expect(written[0].outcome).toBe("no-candidates");
    expect(written[0].candidates).toEqual([]);
  });

  it("does not record an attempt for a failure healing never engaged", async () => {
    // An assertion that resolved its element and found the wrong value is an
    // app bug, not a heal that failed. Recording it would put a "the element is
    // gone" signal against a step whose element was right there.
    fs.rmSync(healDir, { recursive: true, force: true });
    const mod = await loadFixture({ "testid|submit": entry() });
    const page = makePage();
    page.failures.set("testid=submit", "Element is not a checkbox");
    mod.installHealing(page);

    await expect(page.getByTestId("submit").click()).rejects.toThrow("Element is not a checkbox");
    expect(fs.existsSync(path.join(healDir, "heals.json"))).toBe(false);
  });

  it("tags a successful heal with its outcome too", async () => {
    // Both kinds share one file, so the reader needs the discriminator on both.
    // An event with NO outcome predates the field and is read as a heal — that
    // was the only kind ever written — so this is what keeps new heals from
    // relying on that backwards-compatibility path.
    fs.rmSync(healDir, { recursive: true, force: true });
    const mod = await loadFixture({ "testid|submit": entry() });
    const page = makePage();
    page.failures.set("testid=submit", "Timeout 30000ms exceeded waiting for locator");
    page.probeResult = [{ locator: { k: "testid", v: "submit-v2" } }];
    mod.installHealing(page);

    await page.getByTestId("submit").click();

    const written = JSON.parse(fs.readFileSync(path.join(healDir, "heals.json"), "utf-8"));
    expect(written[0].outcome).toBe("healed");
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

// ── What the locator actually matched ────────────────────────────────
// Playwright's strict-mode error says a locator "resolved to 10 elements" and
// nothing about what those elements ARE, so a model — or a person reading the
// log — can say the locator is ambiguous and cannot say which match was meant.
// This is the record that answers it, and it is written from inside the page.

function el(over: Partial<FakeElement> = {}): FakeElement {
  const e: FakeElement = {
    tagName: "BUTTON",
    id: "",
    className: "",
    textContent: "",
    disabled: false,
    attrs: {},
    parentElement: null,
    getAttribute: (name: string) => e.attrs[name] ?? null,
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 30, height: 40 }),
    ...over,
  };
  // Re-bound after the spread: an `over` that replaces `attrs` would otherwise
  // leave getAttribute closed over the original empty object.
  e.getAttribute = (name: string) => e.attrs[name] ?? null;
  return e;
}

function readMatches(): Record<string, unknown>[] {
  return JSON.parse(fs.readFileSync(path.join(healDir, "matches.json"), "utf-8"));
}

describe("recording what the failing locator matched", () => {
  beforeEach(() => {
    fs.rmSync(path.join(healDir, "matches.json"), { force: true });
  });

  it("describes every matched element, with what would tell them apart", async () => {
    const player = el({ tagName: "DIV", attrs: { "data-testid": "video-player" } });
    const mod = await loadFixture({ "role|button|Pause": entry({ locator: { k: "role", role: "button", name: "Pause" } }) });
    const page = makePage();
    page.failures.set("role=button/Pause", "strict mode violation: resolved to 10 elements");
    page.matchElements = [
      el({ className: "player-control pause", attrs: { "data-testid": "video-pause", "aria-label": "Pause" }, parentElement: player }),
      el({ textContent: "  Pause  ", disabled: true }),
    ];
    mod.installHealing(page);

    await expect(page.getByRole("button", { name: "Pause" }).click()).rejects.toThrow(/strict mode/);

    const written = readMatches();
    expect(written).toHaveLength(1);
    expect(written[0].matchCount).toBe(2);
    const matches = written[0].matches as Record<string, unknown>[];
    expect(matches[0].testid).toBe("video-pause");
    expect(matches[0].ariaLabel).toBe("Pause");
    expect(matches[0].classes).toEqual(["player-control", "pause"]);
    // The scoping handle: this is what a fix is actually written from, and it
    // is the difference between a real answer and .first().
    expect(matches[0].ancestors).toEqual(["div[data-testid=video-player]"]);
    expect(matches[1].text).toBe("Pause");
    expect(matches[1].enabled).toBe(false);
  });

  it("records the TRUE count even when the list is capped", async () => {
    // A capped list that does not say so reads as the whole set, which is how
    // a model concludes the element it wants is not on the page.
    const mod = await loadFixture({ "testid|submit": entry() });
    const page = makePage();
    page.failures.set("testid=submit", "strict mode violation: resolved to 40 elements");
    page.matchElements = Array.from({ length: 40 }, () => el());
    mod.installHealing(page);

    await expect(page.getByTestId("submit").click()).rejects.toThrow();

    const written = readMatches();
    expect(written[0].matchCount).toBe(40);
    expect((written[0].matches as unknown[]).length).toBeLessThanOrEqual(20);
  });

  it("records the matches BEFORE a heal changes the page", async () => {
    // A heal clicks something. What matched at the moment of failure is the
    // thing being described, so recording afterwards would describe the page
    // the heal left behind — and this path succeeds, so nothing else would
    // ever notice.
    const mod = await loadFixture({ "testid|submit": entry() });
    const page = makePage();
    page.failures.set("testid=submit", "strict mode violation: resolved to 2 elements");
    page.matchElements = [el({ id: "a" }), el({ id: "b" })];
    page.probeResult = [{ locator: { k: "testid", v: "submit-v2" } }];
    mod.installHealing(page);

    const result = await page.getByTestId("submit").click();
    expect(result).toBe("testid=submit-v2:click");
    // Healed, so heal-failures records nothing — and the ambiguity is still
    // the most useful thing anyone could learn about this run.
    expect(readMatches()[0].matchCount).toBe(2);
  });

  it("never turns a page it cannot describe into a second failure", async () => {
    // Diagnostics are best-effort. A locator whose evaluateAll throws must
    // leave the run exactly as it was: same error out, heal still attempted.
    const mod = await loadFixture({ "testid|submit": entry() });
    const page = makePage();
    page.failures.set("testid=submit", "Timeout 30000ms exceeded waiting for locator");
    Object.defineProperty(page.matchElements, "slice", {
      value: () => {
        throw new Error("page is hostile");
      },
    });
    page.probeResult = [{ locator: { k: "testid", v: "submit-v2" } }];
    mod.installHealing(page);

    const result = await page.getByTestId("submit").click();
    expect(result).toBe("testid=submit-v2:click");
    expect(fs.existsSync(path.join(healDir, "matches.json"))).toBe(false);
  });

  it("records nothing for a failure healing never engaged", async () => {
    // No map entry means no step identity, so there is nothing to key a
    // record to — and an unrecorded locator must not be described either.
    const mod = await loadFixture({});
    const page = makePage();
    page.failures.set("testid=unknown", "strict mode violation: resolved to 3 elements");
    page.matchElements = [el(), el(), el()];
    mod.installHealing(page);

    await expect(page.getByTestId("unknown").click()).rejects.toThrow(/strict mode/);
    expect(fs.existsSync(path.join(healDir, "matches.json"))).toBe(false);
  });
});

// ── Evidence for propagation: page URL and element rect ──────────────
// A heal grouped by the page it actually happened on beats grouping by the
// test's start URL, and the healed element's box is where the evidence
// screenshot's highlight gets drawn. Both are best-effort page-derived
// values: a page that will not answer costs the field, never the event, and
// the runner validates them before they reach the journal.

describe("evidence: page URL and healed-element rect on events", () => {
  beforeEach(() => {
    fs.rmSync(healDir, { recursive: true, force: true });
  });

  it("records the URL and the viewport-normalized box on a healed event", async () => {
    const mod = await loadFixture({ "testid|submit": entry() });
    const page = makePage();
    page.failures.set("testid=submit", "Timeout 30000ms exceeded waiting for locator");
    page.probeResult = [{ locator: { k: "testid", v: "submit-v2" } }];
    page.boxes.set("testid=submit-v2", { x: 100, y: 50, width: 200, height: 100 });
    mod.installHealing(page);

    await page.getByTestId("submit").click();

    const written = JSON.parse(fs.readFileSync(path.join(healDir, "heals.json"), "utf-8"));
    expect(written[0].url).toBe("https://shop.example.test/checkout?step=2");
    // 1000x500 viewport: exact division, so exact equality is safe.
    expect(written[0].rect).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    // Measured BEFORE the action — a healed click that navigates away cannot
    // erase the answer. The fake logs both, in order.
    expect(page.performed).toEqual(["testid=submit-v2:boundingBox", "testid=submit-v2:click"]);
  });

  it("clips the box to the viewport — the region the screenshot actually shows", async () => {
    const mod = await loadFixture({ "testid|submit": entry() });
    const page = makePage();
    page.failures.set("testid=submit", "Timeout 30000ms exceeded waiting for locator");
    page.probeResult = [{ locator: { k: "testid", v: "submit-v2" } }];
    // Overhangs the left edge and the bottom edge; only the intersection is
    // in the shot, so only the intersection is the honest answer.
    page.boxes.set("testid=submit-v2", { x: -50, y: 400, width: 100, height: 200 });
    mod.installHealing(page);

    await page.getByTestId("submit").click();

    const written = JSON.parse(fs.readFileSync(path.join(healDir, "heals.json"), "utf-8"));
    expect(written[0].rect).toEqual({ x: 0, y: 0.8, w: 0.05, h: 0.2 });
  });

  it("an element whose box cannot be read still heals, with no rect field", async () => {
    const mod = await loadFixture({ "testid|submit": entry() });
    const page = makePage();
    page.failures.set("testid=submit", "Timeout 30000ms exceeded waiting for locator");
    page.probeResult = [{ locator: { k: "testid", v: "submit-v2" } }];
    // No boxes entry: boundingBox throws, the degraded path.
    mod.installHealing(page);

    const result = await page.getByTestId("submit").click();
    expect(result).toBe("testid=submit-v2:click");

    const written = JSON.parse(fs.readFileSync(path.join(healDir, "heals.json"), "utf-8"));
    expect("rect" in written[0]).toBe(false);
    expect(written[0].url).toBe("https://shop.example.test/checkout?step=2");
  });

  it("no viewport means no rect — a box that cannot be normalized is not written", async () => {
    const mod = await loadFixture({ "testid|submit": entry() });
    const page = makePage();
    page.failures.set("testid=submit", "Timeout 30000ms exceeded waiting for locator");
    page.probeResult = [{ locator: { k: "testid", v: "submit-v2" } }];
    page.boxes.set("testid=submit-v2", { x: 100, y: 50, width: 200, height: 100 });
    page.viewport = null;
    mod.installHealing(page);

    await page.getByTestId("submit").click();
    const written = JSON.parse(fs.readFileSync(path.join(healDir, "heals.json"), "utf-8"));
    expect("rect" in written[0]).toBe(false);
  });

  it("a page that cannot answer url() costs the field, never the heal", async () => {
    const mod = await loadFixture({ "testid|submit": entry() });
    const page = makePage();
    page.failures.set("testid=submit", "Timeout 30000ms exceeded waiting for locator");
    page.probeResult = [{ locator: { k: "testid", v: "submit-v2" } }];
    page.urlThrows = true;
    mod.installHealing(page);

    const result = await page.getByTestId("submit").click();
    expect(result).toBe("testid=submit-v2:click");

    const written = JSON.parse(fs.readFileSync(path.join(healDir, "heals.json"), "utf-8"));
    expect("url" in written[0]).toBe(false);
  });

  it("a failed attempt records the URL too — where the element went missing", async () => {
    const mod = await loadFixture({ "testid|submit": entry() });
    const page = makePage();
    page.failures.set("testid=submit", "Timeout 30000ms exceeded waiting for locator");
    page.failures.set("testid=bad", "Timeout 30000ms exceeded waiting for locator");
    page.probeResult = [{ locator: { k: "testid", v: "bad" } }];
    mod.installHealing(page);

    await expect(page.getByTestId("submit").click()).rejects.toThrow("Timeout 30000ms");

    const written = JSON.parse(fs.readFileSync(path.join(healDir, "heals.json"), "utf-8"));
    expect(written[0].outcome).toBe("exhausted");
    expect(written[0].url).toBe("https://shop.example.test/checkout?step=2");
  });

  it("a match set records the URL of the page it describes", async () => {
    const mod = await loadFixture({ "testid|submit": entry() });
    const page = makePage();
    page.failures.set("testid=submit", "strict mode violation: resolved to 2 elements");
    page.matchElements = [el({ id: "a" }), el({ id: "b" })];
    mod.installHealing(page);

    await expect(page.getByTestId("submit").click()).rejects.toThrow(/strict mode/);

    const written = JSON.parse(fs.readFileSync(path.join(healDir, "matches.json"), "utf-8"));
    expect(written[0].url).toBe("https://shop.example.test/checkout?step=2");
  });
});

// ── Seeds: propagation's fixes, tried before the probe ───────────────
// A pending cross-test proposal rides the map entry as `seeds`. It runs only
// once the recorded locator has ACTUALLY failed, it spends no probe when it
// works, and it records an ordinary healed event flagged `seeded` — so the
// journal still shows that the page changed.

describe("seeded healing", () => {
  beforeEach(() => {
    fs.rmSync(healDir, { recursive: true, force: true });
  });

  it("tries a seed before spending a probe, and flags the event", async () => {
    const mod = await loadFixture({
      "testid|submit": entry({ seeds: [{ k: "testid", v: "submit-v2" }] }),
    });
    const page = makePage();
    page.failures.set("testid=submit", "Timeout 30000ms exceeded waiting for locator");
    // The probe WOULD offer something else — it must not even be consulted.
    page.probeResult = [{ locator: { k: "testid", v: "probe-answer" } }];
    mod.installHealing(page);

    const result = await page.getByTestId("submit").click();

    expect(result).toBe("testid=submit-v2:click");
    expect(page.evaluatedProbes).toHaveLength(0);
    const written = JSON.parse(fs.readFileSync(path.join(healDir, "heals.json"), "utf-8"));
    expect(written).toHaveLength(1);
    expect(written[0].outcome).toBe("healed");
    expect(written[0].seeded).toBe(true);
    expect(written[0].appliedLocator).toEqual({ k: "testid", v: "submit-v2" });
    expect(written[0].originalLocator).toEqual({ k: "testid", v: "submit" });
  });

  it("a failing seed costs one attempt and falls through to the probe", async () => {
    const mod = await loadFixture({
      "testid|submit": entry({ seeds: [{ k: "testid", v: "stale-seed" }] }),
    });
    const page = makePage();
    page.failures.set("testid=submit", "Timeout 30000ms exceeded waiting for locator");
    page.failures.set("testid=stale-seed", "Timeout 30000ms exceeded waiting for locator");
    page.probeResult = [{ locator: { k: "testid", v: "probe-answer" } }];
    mod.installHealing(page);

    const result = await page.getByTestId("submit").click();

    expect(result).toBe("testid=probe-answer:click");
    expect(page.evaluatedProbes).toHaveLength(1);
    const written = JSON.parse(fs.readFileSync(path.join(healDir, "heals.json"), "utf-8"));
    // One event, from the probe path, not flagged as seeded.
    expect(written).toHaveLength(1);
    expect("seeded" in written[0]).toBe(false);
    expect(written[0].appliedLocator).toEqual({ k: "testid", v: "probe-answer" });
  });

  it("a passing action never consults its seeds", async () => {
    const mod = await loadFixture({
      "testid|submit": entry({ seeds: [{ k: "testid", v: "submit-v2" }] }),
    });
    const page = makePage();
    mod.installHealing(page);

    const result = await page.getByTestId("submit").click();
    expect(result).toBe("testid=submit:click");
    expect(fs.existsSync(path.join(healDir, "heals.json"))).toBe(false);
  });
});
