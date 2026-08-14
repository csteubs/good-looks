// Tests for what an imported spec inherited from its own playwright.config —
// above all `use.baseURL`, without which every relative `page.goto("/")` in the
// suite dies in Playwright's protocol layer, in an error that names neither the
// config nor the missing field.
//
// Two properties are what this module is FOR, and most of what follows pins one
// of them:
//
//  1. The config is READ, never evaluated. It is a file from a stranger's
//     repository, opened at the moment the user believes they are only looking,
//     so every value here is lifted out of source text by regex. The tests
//     therefore care as much about what the parser REFUSES — a `${…}` template,
//     a bare host, a `file:` URL, an env var with no literal fallback — as about
//     what it accepts. Each of those refusals is a value that would otherwise be
//     written into a test record and handed to a browser.
//  2. "Does this test need a base URL?" has ONE definition, asked of the whole
//     imported tree. The suite this was written against keeps every navigation
//     in a helper (`gotoWithRetry(page, "/cart")` in the spec, `page.goto` in
//     `helpers.js`), so a spec-only answer is right about the file and wrong
//     about the test — and the import warning and the runner's refusal would
//     then disagree with each other about the same test.
//
// Driven against real temp directories, like `import-service.test.ts`: the
// upward config walk IS filesystem behaviour — symlinked temp roots, project
// markers, level limits — and a mocked fs would only assert my assumptions back
// at me. macOS resolving /var → /private/var is exactly the trap the walk
// realpaths both sides to survive.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  extractBaseUrl,
  extractTestTimeoutMs,
  findProjectConfig,
  findUnsupported,
  firstNavigationUrl,
  isAbsoluteUrl,
  navigationTargets,
  normalizeBaseUrl,
  readProjectConfig,
  shouldRefuseForMissingBaseUrl,
  treeNeedsBaseUrl,
  usesRelativeNavigation,
} from "./imported-config.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-imported-config-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content = ""): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
  return full;
}

function mkdir(rel: string): string {
  const full = path.join(root, rel);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

/** A config with a base URL and nothing else, for walk tests that only care
 *  about WHICH file was found. */
const MINIMAL_CONFIG = `export default { use: { baseURL: "https://found.test" } };\n`;

describe("findProjectConfig", () => {
  it("finds a config sitting beside the spec", () => {
    const specDir = mkdir("proj/tests");
    const cfg = write("proj/tests/playwright.config.ts", MINIMAL_CONFIG);

    expect(findProjectConfig(specDir, specDir)).toBe(fs.realpathSync(cfg));
  });

  it("finds the project's config when the user picked the tests/ subfolder", () => {
    // The real-world case, and the whole reason the walk goes up at all: the
    // folder people choose is `tests/`, and the config sits beside package.json
    // one level above it.
    const specDir = mkdir("proj/tests");
    write("proj/package.json", "{}\n");
    const cfg = write("proj/playwright.config.ts", MINIMAL_CONFIG);

    expect(findProjectConfig(specDir, specDir)).toBe(fs.realpathSync(cfg));
  });

  it("finds a config above the scan root", () => {
    // Scan root is `tests/`; the spec is deeper, the config is higher.
    const scanRoot = mkdir("proj/tests");
    const specDir = mkdir("proj/tests/checkout");
    const cfg = write("proj/playwright.config.ts", MINIMAL_CONFIG);

    expect(findProjectConfig(specDir, scanRoot)).toBe(fs.realpathSync(cfg));
  });

  it("recognises every filename Playwright itself accepts", () => {
    for (const name of [
      "playwright.config.ts",
      "playwright.config.js",
      "playwright.config.mts",
      "playwright.config.mjs",
      "playwright.config.cts",
      "playwright.config.cjs",
    ]) {
      const dir = mkdir(`each/${name.replace(/\./g, "-")}`);
      const cfg = write(`each/${name.replace(/\./g, "-")}/${name}`, MINIMAL_CONFIG);
      expect(findProjectConfig(dir, dir)).toBe(fs.realpathSync(cfg));
    }
  });

  it("stops before a config that is further above the scan root than allowed", () => {
    // Five levels up. A stray playwright.config.ts in somebody's home directory
    // is not this project's config, which is why the walk is bounded at all.
    const specDir = mkdir("a/b/c/d/e");
    const cfg = write("playwright.config.ts", MINIMAL_CONFIG);

    // Non-vacuous: the file really is there, it is just out of reach.
    expect(fs.existsSync(cfg)).toBe(true);
    expect(findProjectConfig(specDir, specDir)).toBeNull();
  });

  it("does not look past a directory holding package.json", () => {
    const specDir = mkdir("outer/proj/tests");
    write("outer/proj/package.json", "{}\n");
    const cfg = write("outer/playwright.config.ts", MINIMAL_CONFIG);

    expect(fs.existsSync(cfg)).toBe(true);
    expect(findProjectConfig(specDir, specDir)).toBeNull();
  });

  it("finds that same config when no package.json marks the boundary", () => {
    // The companion to the test above: proves the refusal there is the project
    // marker doing its job, not the level limit.
    const specDir = mkdir("outer/proj/tests");
    const cfg = write("outer/playwright.config.ts", MINIMAL_CONFIG);

    expect(findProjectConfig(specDir, specDir)).toBe(fs.realpathSync(cfg));
  });

  it("treats .git as a project boundary too", () => {
    const specDir = mkdir("outer/proj/tests");
    mkdir("outer/proj/.git");
    write("outer/playwright.config.ts", MINIMAL_CONFIG);

    expect(findProjectConfig(specDir, specDir)).toBeNull();
  });

  it("still reads the config in a directory that holds package.json", () => {
    // The marker stops the walk AFTER the directory is checked — a config
    // beside package.json is the normal layout, not a boundary violation.
    const specDir = mkdir("proj");
    write("proj/package.json", "{}\n");
    const cfg = write("proj/playwright.config.ts", MINIMAL_CONFIG);

    expect(findProjectConfig(specDir, specDir)).toBe(fs.realpathSync(cfg));
  });

  it("ignores a DIRECTORY named like a config", () => {
    const specDir = mkdir("proj/tests");
    mkdir("proj/tests/playwright.config.ts");

    expect(findProjectConfig(specDir, specDir)).toBeNull();
  });

  it("returns null rather than throwing for a spec dir that does not exist", () => {
    const missing = path.join(root, "nope", "gone", "away");

    expect(findProjectConfig(missing, missing)).toBeNull();
  });

  it("still finds the config when a missing spec dir sits under a real root", () => {
    // A path that does not exist resolves to itself rather than blowing up, so
    // the walk carries on upward and lands on the config it was looking for.
    // Compared through realpath because that fallback leaves the walk on the
    // UNRESOLVED spelling of the path (on macOS, /var rather than /private/var)
    // — the same file, reached by its other name.
    const scanRoot = mkdir("proj");
    const cfg = write("proj/playwright.config.ts", MINIMAL_CONFIG);
    const missing = path.join(scanRoot, "tests", "deleted");

    const found = findProjectConfig(missing, scanRoot);
    expect(found).not.toBeNull();
    expect(fs.realpathSync(found as string)).toBe(fs.realpathSync(cfg));
  });
});

describe("extractBaseUrl", () => {
  it("reads a plain string literal", () => {
    expect(extractBaseUrl(`use: { baseURL: "https://shop.example.com" }`)).toBe(
      "https://shop.example.com/",
    );
  });

  it("keeps a path on the base URL", () => {
    expect(extractBaseUrl(`baseURL: "https://shop.example.com/app"`)).toBe(
      "https://shop.example.com/app",
    );
  });

  it("accepts single quotes and backticks", () => {
    expect(extractBaseUrl(`baseURL: 'https://single.test'`)).toBe("https://single.test/");
    expect(extractBaseUrl("baseURL: `https://backtick.test`")).toBe("https://backtick.test/");
  });

  it("reads the literal behind a process.env fallback", () => {
    expect(extractBaseUrl(`baseURL: process.env.BASE_URL || "https://fallback.test"`)).toBe(
      "https://fallback.test/",
    );
    expect(extractBaseUrl(`baseURL: process.env.PW_BASE_URL ?? 'https://nullish.test'`)).toBe(
      "https://nullish.test/",
    );
  });

  it("tolerates the whitespace real configs are written with", () => {
    expect(extractBaseUrl(`    baseURL   :    "https://spaced.test"   ,\n`)).toBe(
      "https://spaced.test/",
    );
    expect(
      extractBaseUrl(`baseURL: process.env.URL   ||   \n      "https://wrapped.test",`),
    ).toBe("https://wrapped.test/");
  });

  it("refuses a template literal with an interpolation", () => {
    // The value is computed at run time, and we never run the config. Guessing
    // would write a URL containing a literal `${host}` into the test record.
    expect(extractBaseUrl("baseURL: `https://${host}.example.com`")).toBeNull();
  });

  it("refuses an env var with no literal fallback rather than grabbing the next string", () => {
    const source = `use: {\n    baseURL: process.env.BASE_URL,\n    trace: "on-first-retry",\n  }`;
    expect(extractBaseUrl(source)).toBeNull();
  });

  it("refuses a bare host with no scheme", () => {
    expect(extractBaseUrl(`baseURL: "shop.example.com"`)).toBeNull();
  });

  it("refuses an empty string", () => {
    expect(extractBaseUrl(`baseURL: ""`)).toBeNull();
  });

  it("refuses schemes a run has no business following", () => {
    expect(extractBaseUrl(`baseURL: "file:///etc/passwd"`)).toBeNull();
    expect(extractBaseUrl(`baseURL: "javascript:alert(1)"`)).toBeNull();
    expect(extractBaseUrl(`baseURL: "data:text/html,<script>x()</script>"`)).toBeNull();
  });

  it("returns null for a config with no baseURL at all", () => {
    expect(extractBaseUrl(`export default { testDir: "./tests", retries: 2 };`)).toBeNull();
  });
});

describe("normalizeBaseUrl", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeBaseUrl("   https://trim.test   ")).toBe("https://trim.test/");
  });

  it("returns the href form, not the string it was handed", () => {
    expect(normalizeBaseUrl("HTTPS://Shop.Example.COM")).toBe("https://shop.example.com/");
    expect(normalizeBaseUrl("http://localhost:3000")).toBe("http://localhost:3000/");
  });

  it("keeps http and https and nothing else", () => {
    expect(normalizeBaseUrl("http://plain.test/")).toBe("http://plain.test/");
    expect(normalizeBaseUrl("ftp://files.test/")).toBeNull();
    expect(normalizeBaseUrl("app://index.html")).toBeNull();
    expect(normalizeBaseUrl("file:///Users/me/site/index.html")).toBeNull();
  });

  it("rejects a value that is not a string", () => {
    // This is the gate the IPC handler puts a typed-in value through, so the
    // inputs it has to survive are whatever crosses the bridge.
    expect(normalizeBaseUrl(null)).toBeNull();
    expect(normalizeBaseUrl(undefined)).toBeNull();
    expect(normalizeBaseUrl(1234)).toBeNull();
    expect(normalizeBaseUrl({ href: "https://object.test" })).toBeNull();
    expect(normalizeBaseUrl(["https://array.test"])).toBeNull();
  });

  it("rejects an empty or whitespace-only value", () => {
    expect(normalizeBaseUrl("")).toBeNull();
    expect(normalizeBaseUrl("    ")).toBeNull();
  });

  it("rejects a value carrying an uninterpolated template", () => {
    expect(normalizeBaseUrl("https://${env}.example.com")).toBeNull();
  });
});

describe("extractTestTimeoutMs", () => {
  const config = (body: string) => `export default defineConfig({\n${body}});\n`;

  it("reads a top-level timeout, underscores and all", () => {
    expect(extractTestTimeoutMs(config(`  timeout: 120_000,\n`))).toBe(120_000);
    expect(extractTestTimeoutMs(config(`  timeout: 45000,\n`))).toBe(45_000);
  });

  it("does not read the timeout nested under expect", () => {
    // `expect.timeout` and `use.actionTimeout` mean entirely different things,
    // and adopting one as the per-test limit would silently shorten every run.
    const source = config(`  expect: {\n    timeout: 10_000,\n  },\n`);
    expect(extractTestTimeoutMs(source)).toBeNull();
  });

  it("does not read a timeout nested under use", () => {
    const source = config(`  use: {\n    baseURL: "https://x.test",\n    timeout: 5_000,\n  },\n`);
    expect(extractTestTimeoutMs(source)).toBeNull();
  });

  it("takes the top-level one even when nested ones are also present", () => {
    const source = config(
      `  timeout: 90_000,\n  expect: {\n    timeout: 10_000,\n  },\n  use: {\n    timeout: 1_000,\n  },\n`,
    );
    expect(extractTestTimeoutMs(source)).toBe(90_000);
  });

  it("refuses absurd values", () => {
    expect(extractTestTimeoutMs(config(`  timeout: 0,\n`))).toBeNull();
    expect(extractTestTimeoutMs(config(`  timeout: -5000,\n`))).toBeNull();
    // Beyond an hour is a config we don't understand, and adopting it would
    // hang a run somebody is watching.
    expect(extractTestTimeoutMs(config(`  timeout: 7_200_000,\n`))).toBeNull();
  });

  it("accepts exactly one hour", () => {
    expect(extractTestTimeoutMs(config(`  timeout: 3600000,\n`))).toBe(3_600_000);
  });

  it("returns null when there is no timeout", () => {
    expect(extractTestTimeoutMs(config(`  retries: 2,\n`))).toBeNull();
  });
});

describe("findUnsupported", () => {
  it("names a webServer", () => {
    const found = findUnsupported(`webServer: { command: "npm run start", port: 3000 },`);
    expect(found).toEqual([expect.stringContaining("webServer")]);
  });

  it("names globalSetup", () => {
    expect(findUnsupported(`globalSetup: "./global-setup.ts",`)).toEqual([
      expect.stringContaining("globalSetup"),
    ]);
  });

  it("names globalTeardown", () => {
    expect(findUnsupported(`globalTeardown: require.resolve("./teardown"),`)).toEqual([
      expect.stringContaining("globalTeardown"),
    ]);
  });

  it("names storageState", () => {
    expect(findUnsupported(`use: { storageState: "auth.json" },`)).toEqual([
      expect.stringContaining("storageState"),
    ]);
  });

  it("names all four in a fixed order, with the copy the user is shown", () => {
    const source = [
      `globalTeardown: "./t.ts",`,
      `webServer: { command: "npm start" },`,
      `use: { storageState: "auth.json" },`,
      `globalSetup: "./s.ts",`,
    ].join("\n");
    expect(findUnsupported(source)).toEqual([
      "webServer (this app cannot start your dev server)",
      "globalSetup",
      "globalTeardown",
      "storageState (saved sign-in)",
    ]);
  });

  it("returns nothing for a config this app can honour", () => {
    const source = `export default defineConfig({\n  timeout: 30_000,\n  use: { baseURL: "https://ok.test" },\n});\n`;
    expect(findUnsupported(source)).toEqual([]);
  });
});

describe("navigationTargets", () => {
  it("takes an absolute page.goto", () => {
    expect(navigationTargets(`await page.goto("https://shop.test/cart");`)).toEqual([
      "https://shop.test/cart",
    ]);
  });

  it("takes a relative page.goto", () => {
    expect(navigationTargets(`await page.goto("/cart");`)).toEqual(["/cart"]);
  });

  it("sees through the project's own navigation helper", () => {
    // The narrower `page.goto(` pattern finds nothing here, and would report a
    // suite of entirely relative navigations as having none.
    expect(navigationTargets(`await gotoWithRetry(page, "/cart");`)).toEqual(["/cart"]);
    expect(navigationTargets(`await gotoAndWait(page, "/checkout", 3);`)).toEqual(["/checkout"]);
  });

  it("does not mistake an option value for a destination", () => {
    // The literal has to LOOK like a location, or this confidently returns
    // "domcontentloaded" as the URL the test navigates to.
    expect(navigationTargets(`await page.goto(url, { waitUntil: "domcontentloaded" });`)).toEqual(
      [],
    );
  });

  it("takes the destination, not the option, when both are literals", () => {
    expect(navigationTargets(`await page.goto("/cart", { waitUntil: "networkidle" });`)).toEqual([
      "/cart",
    ]);
  });

  it("keeps a protocol-relative target", () => {
    expect(navigationTargets(`await page.goto("//cdn.example.com/app");`)).toEqual([
      "//cdn.example.com/app",
    ]);
  });

  it("skips a computed target rather than guessing at it", () => {
    expect(navigationTargets("await page.goto(`${base}/cart`);")).toEqual([]);
    expect(navigationTargets(`await page.goto("");`)).toEqual([]);
  });

  it("returns every target in source order", () => {
    const source = [
      `await page.goto("https://shop.test/");`,
      `await page.goto("/cart");`,
      `await gotoWithRetry(page, "/checkout");`,
    ].join("\n");
    expect(navigationTargets(source)).toEqual(["https://shop.test/", "/cart", "/checkout"]);
  });

  it("returns nothing for a spec that never navigates", () => {
    expect(navigationTargets(`await page.getByRole("button").click();`)).toEqual([]);
  });

  // A relative destination does not have to start with a slash, and the first
  // version of this only recognised ones that did. Every shape below is an
  // ordinary relative navigation that registered as NO navigation at all — so
  // the import raised no warning, the runner did not refuse the run, and the
  // test failed in the protocol layer this module exists to prevent.
  it.each([
    ["a bare path", `await page.goto("dashboard");`, "dashboard"],
    ["an explicitly relative path", `await page.goto("./cart");`, "./cart"],
    ["a parent-relative path", `await page.goto("../cart");`, "../cart"],
    ["a bare query string", `await page.goto("?tab=orders");`, "?tab=orders"],
    ["a bare fragment", `await page.goto("#summary");`, "#summary"],
  ])("finds %s", (_label, source, expected) => {
    expect(navigationTargets(source)).toEqual([expected]);
    expect(usesRelativeNavigation(source)).toBe(true);
  });

  it("still tells a destination from an option when the destination is bare", () => {
    // The pair that makes the rule above safe: position and nesting decide,
    // not what the string looks like. Reading any literal in the call would
    // report a navigation to "domcontentloaded" here.
    expect(
      navigationTargets(`await page.goto("dashboard", { waitUntil: "domcontentloaded" });`),
    ).toEqual(["dashboard"]);
  });

  // Two of the five specs this feature was first run against navigate this
  // way. A literals-only reader calls them "navigates nowhere", so they get no
  // warning at import, no refusal at run time, and fail in the protocol layer.
  it("resolves a destination held in a const in the same file", () => {
    const source = [
      `const STARTER_SET_PATH = '/pages/pregnancy-starter-set';`,
      ``,
      `const response = await gotoWithRetry(page, STARTER_SET_PATH, { logStep });`,
    ].join("\n");
    expect(navigationTargets(source)).toEqual(["/pages/pregnancy-starter-set"]);
    expect(usesRelativeNavigation(source)).toBe(true);
  });

  it("resolves one whose declaration a formatter wrapped onto the next line", () => {
    const source = [
      `const PRODUCT_PATH =`,
      `  '/products/iron-bioseries';`,
      `await gotoWithRetry(page, PRODUCT_PATH);`,
    ].join("\n");
    expect(navigationTargets(source)).toEqual(["/products/iron-bioseries"]);
  });

  it("leaves an absolute const absolute, so it is not flagged as needing a base URL", () => {
    const source = [
      `const HOME = "https://shop.test/";`,
      `await page.goto(HOME);`,
    ].join("\n");
    expect(navigationTargets(source)).toEqual(["https://shop.test/"]);
    expect(usesRelativeNavigation(source)).toBe(false);
  });

  it("says nothing about a const it cannot see", () => {
    // Imported from another module: unresolved is the honest answer, and a
    // guess here would either warn about a working test or hide a broken one.
    const source = [
      `import { PRODUCT_PATH } from "./paths.js";`,
      `await gotoWithRetry(page, PRODUCT_PATH);`,
    ].join("\n");
    expect(navigationTargets(source)).toEqual([]);
  });

  it("ignores a literal buried past the destination's argument slots", () => {
    expect(
      navigationTargets(`await gotoWithRetry(page, url, 3, { referer: "https://ref.test/" });`),
    ).toEqual([]);
  });
});

describe("isAbsoluteUrl", () => {
  it("is true for a scheme and for a protocol-relative host", () => {
    expect(isAbsoluteUrl("https://a.test/x")).toBe(true);
    expect(isAbsoluteUrl("http://a.test")).toBe(true);
    // A browser supplies the scheme; this one is not waiting on a baseURL.
    expect(isAbsoluteUrl("//cdn.test/x")).toBe(true);
  });

  it("is false for a path", () => {
    expect(isAbsoluteUrl("/cart")).toBe(false);
    expect(isAbsoluteUrl("/")).toBe(false);
  });
});

describe("usesRelativeNavigation", () => {
  it("is true when any navigation needs a base to resolve against", () => {
    expect(usesRelativeNavigation(`await page.goto("/");`)).toBe(true);
    expect(
      usesRelativeNavigation(
        `await page.goto("https://shop.test/");\nawait gotoWithRetry(page, "/cart");`,
      ),
    ).toBe(true);
  });

  it("is false when every navigation stands on its own", () => {
    expect(
      usesRelativeNavigation(
        `await page.goto("https://shop.test/");\nawait page.goto("//cdn.test/x");`,
      ),
    ).toBe(false);
  });

  it("is false for a spec with no navigation", () => {
    expect(usesRelativeNavigation(`await page.getByText("Cart").click();`)).toBe(false);
  });
});

describe("firstNavigationUrl", () => {
  it("returns the first absolute target, normalised", () => {
    expect(
      firstNavigationUrl(`await page.goto("https://Shop.test");\nawait page.goto("/cart");`),
    ).toBe("https://shop.test/");
  });

  it("resolves a relative target against the base URL", () => {
    expect(firstNavigationUrl(`await page.goto("/cart");`, "https://shop.test")).toBe(
      "https://shop.test/cart",
    );
    expect(firstNavigationUrl(`await gotoWithRetry(page, "/");`, "https://shop.test/app/")).toBe(
      "https://shop.test/",
    );
  });

  it("returns empty for a relative target with no base", () => {
    // A stored "/" looks like a URL to everything downstream that treats the
    // field as one, which is worse than an empty column.
    expect(firstNavigationUrl(`await page.goto("/cart");`)).toBe("");
  });

  it("falls through a relative target to a later absolute one when there is no base", () => {
    const source = `await page.goto("/cart");\nawait page.goto("https://shop.test/checkout");`;
    expect(firstNavigationUrl(source)).toBe("https://shop.test/checkout");
  });

  it("skips an absolute target whose scheme is not http(s)", () => {
    const source = `await page.goto("file:///etc/passwd");\nawait page.goto("https://ok.test/x");`;
    expect(firstNavigationUrl(source)).toBe("https://ok.test/x");
  });

  it("falls back to the base URL when the spec names no target", () => {
    expect(firstNavigationUrl(`await page.click("#go");`, "https://shop.test")).toBe(
      "https://shop.test",
    );
    expect(firstNavigationUrl(`await page.click("#go");`)).toBe("");
  });
});

describe("treeNeedsBaseUrl", () => {
  it("is true when only a SIBLING file holds the relative navigation", () => {
    // The case the whole design turns on. The spec calls the project's helper
    // and names no URL at all; `helpers.js`, copied beside it, is where the
    // `page.goto("/cart")` lives. A spec-only answer here is "no", and the test
    // then imports without a warning and fails on its first run.
    const sandbox = mkdir("sandbox");
    const specPath = write(
      "sandbox/cart.spec.ts",
      `import { visitCart } from "./helpers.js";\ntest("cart", async ({ page }) => {\n  await visitCart(page);\n});\n`,
    );
    write(
      "sandbox/helpers.js",
      `export async function visitCart(page) {\n  await page.goto("/cart");\n}\n`,
    );

    // Non-vacuous in both directions: the spec alone genuinely says "no".
    expect(usesRelativeNavigation(fs.readFileSync(specPath, "utf-8"))).toBe(false);
    expect(treeNeedsBaseUrl(specPath)).toBe(false);
    expect(treeNeedsBaseUrl(specPath, sandbox)).toBe(true);
  });

  it("is false when every navigation in the tree is absolute", () => {
    const sandbox = mkdir("sandbox");
    const specPath = write(
      "sandbox/home.spec.ts",
      `await page.goto("https://shop.test/");\nawait visit(page);\n`,
    );
    write("sandbox/helpers.ts", `await page.goto("https://shop.test/cart");\n`);

    expect(treeNeedsBaseUrl(specPath, sandbox)).toBe(false);
  });

  it("finds the navigation in a nested helper directory", () => {
    const sandbox = mkdir("sandbox");
    const specPath = write("sandbox/a.spec.ts", `await visit(page);\n`);
    write("sandbox/support/nav/go.mjs", `await page.goto("/");\n`);

    expect(treeNeedsBaseUrl(specPath, sandbox)).toBe(true);
  });

  it("reads the spec itself even when it is outside the sandbox scan", () => {
    const sandbox = mkdir("sandbox");
    const specPath = write("elsewhere/solo.spec.ts", `await page.goto("/");\n`);

    expect(treeNeedsBaseUrl(specPath, sandbox)).toBe(true);
  });

  it("ignores files that are not source", () => {
    // A README quoting `page.goto("/")` is documentation, not a navigation.
    const sandbox = mkdir("sandbox");
    const specPath = write("sandbox/a.spec.ts", `await page.goto("https://shop.test/");\n`);
    write("sandbox/README.md", `Call \`page.goto("/")\` to start.\n`);
    write("sandbox/fixture.json", `{ "url": "/cart" }\n`);

    expect(treeNeedsBaseUrl(specPath, sandbox)).toBe(false);
  });

  it("is false rather than throwing when nothing is on disk", () => {
    expect(treeNeedsBaseUrl(path.join(root, "gone.spec.ts"), path.join(root, "gone"))).toBe(false);
  });
});

describe("shouldRefuseForMissingBaseUrl", () => {
  function importedTest(): { scriptPath: string; sandbox: string } {
    const sandbox = mkdir("sandbox");
    const scriptPath = write("sandbox/cart.spec.ts", `await page.goto("/cart");\n`);
    return { scriptPath, sandbox };
  }

  it("refuses an imported test that navigates relatively with no base URL", () => {
    const { scriptPath, sandbox } = importedTest();
    expect(
      shouldRefuseForMissingBaseUrl({ scriptPath, sourceDir: "/src/proj/tests" }, sandbox),
    ).toBe(true);
  });

  it("allows the same test once it has a base URL", () => {
    const { scriptPath, sandbox } = importedTest();
    expect(
      shouldRefuseForMissingBaseUrl(
        { scriptPath, sourceDir: "/src/proj/tests", baseUrl: "https://shop.test/" },
        sandbox,
      ),
    ).toBe(false);
  });

  it("allows a test that was not imported", () => {
    // A recorded test navigates to absolute URLs and has no sourceDir; the
    // refusal must never be able to reach one.
    const { scriptPath, sandbox } = importedTest();
    expect(shouldRefuseForMissingBaseUrl({ scriptPath }, sandbox)).toBe(false);
  });

  it("allows an imported test whose navigations are all absolute", () => {
    // Blocking this one would refuse a working test over a field it has no use
    // for.
    const sandbox = mkdir("sandbox");
    const scriptPath = write("sandbox/abs.spec.ts", `await page.goto("https://shop.test/cart");\n`);
    expect(
      shouldRefuseForMissingBaseUrl({ scriptPath, sourceDir: "/src/proj/tests" }, sandbox),
    ).toBe(false);
  });

  it("refuses when the relative navigation is in a sibling, not the spec", () => {
    const sandbox = mkdir("sandbox");
    const scriptPath = write("sandbox/cart.spec.ts", `await visitCart(page);\n`);
    write("sandbox/helpers.js", `await page.goto("/cart");\n`);

    expect(
      shouldRefuseForMissingBaseUrl({ scriptPath, sourceDir: "/src/proj/tests" }, sandbox),
    ).toBe(true);
  });
});

describe("readProjectConfig", () => {
  const REALISTIC_CONFIG = [
    `import { defineConfig, devices } from "@playwright/test";`,
    ``,
    `export default defineConfig({`,
    `  testDir: "./tests",`,
    `  timeout: 120_000,`,
    `  retries: 2,`,
    `  expect: {`,
    `    timeout: 10_000,`,
    `  },`,
    `  webServer: {`,
    `    command: "npm run start",`,
    `    port: 3000,`,
    `  },`,
    `  use: {`,
    `    baseURL: process.env.BASE_URL || "https://shop.example.com",`,
    `    trace: "on-first-retry",`,
    `    storageState: "auth.json",`,
    `  },`,
    `});`,
    ``,
  ].join("\n");

  it("reads a realistic config found above the picked folder", () => {
    const specDir = mkdir("proj/tests");
    write("proj/package.json", "{}\n");
    const cfg = write("proj/playwright.config.ts", REALISTIC_CONFIG);

    const read = readProjectConfig(specDir, specDir);
    expect(read).toEqual({
      configPath: fs.realpathSync(cfg),
      baseUrl: "https://shop.example.com/",
      timeoutMs: 120_000,
      unsupported: [
        "webServer (this app cannot start your dev server)",
        "storageState (saved sign-in)",
      ],
    });
  });

  it("omits the fields it could not read rather than inventing them", () => {
    const specDir = mkdir("proj");
    write("proj/playwright.config.ts", "export default { testDir: './tests' };\n");

    const read = readProjectConfig(specDir, specDir);
    expect(read?.baseUrl).toBeUndefined();
    expect(read?.timeoutMs).toBeUndefined();
    expect(read?.unsupported).toEqual([]);
  });

  it("returns null when the project has no config", () => {
    const specDir = mkdir("proj/tests");
    write("proj/package.json", "{}\n");

    expect(readProjectConfig(specDir, specDir)).toBeNull();
  });

  it("does not execute the config it reads", () => {
    // Importing is the moment the user believes they are only LOOKING. A config
    // from a stranger's repository must not get to run then — before a single
    // test has been run, and with none of the sandboxing a run gets.
    const specDir = mkdir("proj");
    const sentinel = path.join(root, "EXECUTED");
    write(
      "proj/playwright.config.ts",
      [
        `import * as fs from "node:fs";`,
        `fs.writeFileSync(${JSON.stringify(sentinel)}, "pwned");`,
        `throw new Error("this config would blow up if it were evaluated");`,
        `export default { use: { baseURL: "https://safe.test" } };`,
        ``,
      ].join("\n"),
    );

    const read = readProjectConfig(specDir, specDir);
    expect(read?.baseUrl).toBe("https://safe.test/");
    expect(fs.existsSync(sentinel)).toBe(false);
  });
});
