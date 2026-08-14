// Standalone regression check for the imported-project sandbox.
//
// Importing a Playwright project copies the spec's relative-import siblings in,
// so the spec still runs once its original folder or git checkout is gone. A
// relative specifier is just text in a file the IMPORTER wrote, and
// `path.resolve` walks `..` as far as it is told — so destinations built as
// `join(scriptsDir, relative(specDir, resolved))` walked straight back out of
// the scripts dir. The deeper the spec sat in the importer's own tree, the
// further out it reached: seven levels put the write at `/Users/<name>`, and
// `mkdirSync(recursive)` created whatever directories it needed on the way.
//
// That made cloning a repo — the thing you do BEFORE running its tests, to
// look at them — enough to drop attacker-controlled content at an
// attacker-chosen absolute path. `~/Library/LaunchAgents/x.plist` is the
// obvious one, and it needs no test run at all.
//
// What's pinned here:
//   • a legitimate parent-directory import still resolves (the reason the fix
//     is a sandbox and not just a ".." ban — that layout is supported, and
//     `import-service.test.ts` covers it);
//   • a specifier climbing out of the project is refused;
//   • a symlink pointing outside is refused, since statSync/copyFileSync both
//     follow links and would otherwise copy the TARGET's contents in;
//   • nothing is ever written outside the sandbox;
//   • deleting an imported test takes its sandbox with it.
//
// It is also the only place the RECORD an import writes can be checked at all.
// `importFound` is private and `importService.importFromFiles` is the sole path
// to it, so what a spec inherits from its own playwright.config — the base URL
// its relative navigations resolve against, the per-test timeout, the config
// features this app cannot reproduce — is invisible to a unit test with no
// store behind it. Section 5 drives that path end to end, with the picker
// answered by the shell stub.
//
// Bundled with esbuild + the @shell/backend stub — see package.json. Run:
//   npm run check:import-sandbox

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { TestRecord } from "../../recorder/types.js";

// The stores resolve their data dir the moment they load, so the temp userData
// has to be set before the modules are imported — hence the dynamic imports.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-import-sandbox-check-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { backfillBaseUrl, importedSandboxDir, importService, isInside, repairImports, scanDir } =
  await import("../import-service.js");
const { testStore, getScriptsDir } = await import("../test-store.js");
// The same module instance `import-service.ts` sees: `@shell/backend` is
// aliased to this file for the bundle, so answering the picker here answers the
// one the service calls.
const { setOpenDialogResult } = await import("./shell-backend-stub.js");

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(
      `FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  } else {
    console.log(`ok   ${label}`);
  }
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
}

/** Every file under `dir`, as paths relative to it. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * What an imported record inherits from the project's own playwright.config.
 *
 * Every import here runs through `importFromFiles`, picker and all, because
 * that is the only way into `importFound` — the private function that writes
 * the record. None of these fields exists one function earlier: the base URL a
 * relative navigation resolves against, the absolute URL the sidebar shows, the
 * adopted timeout, and the two lists the import summary warns from are all
 * properties of a SAVED record, and the app runs every imported spec under one
 * generated config that supplies none of them.
 */
async function checkConfigInheritance(): Promise<void> {
  // ── A project whose config sits at its ROOT, scanned from tests/ ──────────
  //
  // The layout of most Playwright projects and of the suite this was written
  // against: the user picks `tests/`, and `playwright.config.js` is one level
  // above it beside package.json. A search that refused to look above the
  // folder the user picked would find nothing in the common case.
  const shop = path.join(userData, "shop");
  write(path.join(shop, "package.json"), '{ "name": "shop" }\n');
  write(
    path.join(shop, "playwright.config.js"),
    [
      'import { defineConfig } from "@playwright/test";',
      "",
      "export default defineConfig({",
      "  timeout: 90_000,",
      "  use: {",
      '    baseURL: process.env.PW_BASE_URL || "https://shop.example.com",',
      "  },",
      "});",
    ].join("\n") + "\n",
  );
  write(
    path.join(shop, "tests", "cart.spec.ts"),
    [
      'import { test } from "@playwright/test";',
      "",
      'test("Cart totals", async ({ page }) => {',
      '  await page.goto("/cart");',
      "});",
    ].join("\n") + "\n",
  );

  setOpenDialogResult(path.join(shop, "tests"));
  const shopResult = await importService.importFromFiles();
  assertEqual(shopResult.imported, 1, "the shop project's one spec is imported");
  const cart = testStore.get(shopResult.ids[0]);
  assertEqual(
    cart?.baseUrl,
    "https://shop.example.com/",
    "a config ABOVE the scanned folder still supplies the record's base URL",
  );
  assertEqual(
    cart?.url,
    "https://shop.example.com/cart",
    "…and the relative goto is stored as an absolute URL, not as a bare /cart",
  );
  assertEqual(cart?.testTimeoutMs, 90_000, "the project's per-test timeout is adopted, not dropped");
  assertEqual(shopResult.needsBaseUrl, [], "a suite that HAS a base URL is not flagged as needing one");
  assertEqual(shopResult.unsupported, [], "…and that config asks for nothing this app cannot do");

  // ── A project with no config at all ──────────────────────────────────────
  //
  // Both specs navigate relatively and nothing can say where to, so both are
  // named while the user is still looking at the import — rather than found
  // later as a Playwright protocol error naming neither the config nor the URL.
  const bare = path.join(userData, "bare");
  write(path.join(bare, "package.json"), '{ "name": "bare" }\n');
  write(
    path.join(bare, "tests", "login.spec.ts"),
    [
      'import { test } from "@playwright/test";',
      "",
      'test("Sign in", async ({ page }) => {',
      '  await page.goto("/login");',
      "});",
    ].join("\n") + "\n",
  );
  // The second spec names no location itself — its navigation lives in a helper
  // module. Only a scan of the whole SANDBOX, spec plus the siblings just
  // copied in beside it, can see that this test needs a base URL too, which is
  // the shape the real suite has.
  write(
    path.join(bare, "tests", "helpers", "nav.js"),
    'export async function visit(page) {\n  await page.goto("/dashboard");\n}\n',
  );
  write(
    path.join(bare, "tests", "checkout.spec.ts"),
    [
      'import { test } from "@playwright/test";',
      'import { visit } from "./helpers/nav.js";',
      "",
      'test("Checkout", async ({ page }) => {',
      "  await visit(page);",
      "});",
    ].join("\n") + "\n",
  );

  setOpenDialogResult(path.join(bare, "tests"));
  const bareResult = await importService.importFromFiles();
  assertEqual(bareResult.imported, 2, "both of the bare project's specs are imported");
  assertEqual(
    [...bareResult.needsBaseUrl].sort(),
    ["Checkout", "Sign in"],
    "each relative suite with no config is named, the one whose goto is in a helper included",
  );
  const login = testStore.get(bareResult.ids[bareResult.names.indexOf("Sign in")]);
  assertEqual(login?.url, "", "with nothing to resolve against, the URL is empty rather than /");
  assertEqual(login?.baseUrl, undefined, "…and no base URL is invented to fill the gap");

  // ── A config asking for something this app does not reproduce ────────────
  const served = path.join(userData, "served");
  write(path.join(served, "package.json"), '{ "name": "served" }\n');
  write(
    path.join(served, "playwright.config.ts"),
    [
      'import { defineConfig } from "@playwright/test";',
      "",
      "export default defineConfig({",
      '  webServer: { command: "npm run dev", port: 4173, reuseExistingServer: true },',
      "  use: {",
      '    baseURL: "http://127.0.0.1:4173",',
      "  },",
      "});",
    ].join("\n") + "\n",
  );
  write(
    path.join(served, "tests", "home.spec.ts"),
    [
      'import { test } from "@playwright/test";',
      "",
      'test("Home", async ({ page }) => {',
      '  await page.goto("/");',
      "});",
    ].join("\n") + "\n",
  );

  setOpenDialogResult(path.join(served, "tests"));
  const servedResult = await importService.importFromFiles();
  assertEqual(servedResult.unsupported.length, 1, "the config's one unsupported feature is reported");
  assert(
    (servedResult.unsupported[0] ?? "").startsWith("webServer"),
    "…and it names the webServer, which nothing here will start for the suite",
  );
  assertEqual(
    servedResult.needsBaseUrl,
    [],
    "the test itself still runs: the same config that wants a server also gave it a base URL",
  );

  // ── A record from BEFORE any of this existed ─────────────────────────────
  //
  // Every test imported before the base URL was carried is in this state:
  // `sourceDir`/`sourceRoot` and nothing else. The run would be refused, and
  // the only fix on offer would be typing one URL per test into a library that
  // was imported in a single action. So a refusal asks the source project
  // first, and adopts what it finds.
  const legacyId = "22222222-2222-4222-8222-222222222222";
  const legacyScript = path.join(importedSandboxDir(legacyId), "tests", "cart.spec.ts");
  write(legacyScript, fs.readFileSync(path.join(shop, "tests", "cart.spec.ts"), "utf-8"));
  testStore.save({
    id: legacyId,
    name: "Imported before base URLs existed",
    url: "",
    createdAt: 0,
    updatedAt: 0,
    steps: [],
    scriptPath: legacyScript,
    scriptEdited: true,
    sourceDir: path.join(shop, "tests"),
    sourceRoot: shop,
  });

  assertEqual(
    backfillBaseUrl(legacyId),
    "https://shop.example.com/",
    "a legacy record's base URL is read back from the project it was imported from",
  );
  assertEqual(
    testStore.get(legacyId)?.baseUrl,
    "https://shop.example.com/",
    "…and it is saved on the record, so the next run needs no repair at all",
  );

  // Non-vacuous in the direction that matters: it must not invent one when
  // there is nothing to read, or overwrite a URL the user set by hand.
  const noSourceId = "33333333-3333-4333-8333-333333333333";
  const noSourceScript = path.join(importedSandboxDir(noSourceId), "a.spec.ts");
  write(noSourceScript, 'await page.goto("/cart");\n');
  testStore.save({
    id: noSourceId,
    name: "No source folder",
    url: "",
    createdAt: 0,
    updatedAt: 0,
    steps: [],
    scriptPath: noSourceScript,
    scriptEdited: true,
  });
  assertEqual(backfillBaseUrl(noSourceId), null, "a record with no source folder gets nothing");

  const chosenId = "44444444-4444-4444-8444-444444444444";
  const chosenScript = path.join(importedSandboxDir(chosenId), "tests", "cart.spec.ts");
  write(chosenScript, 'await page.goto("/cart");\n');
  testStore.save({
    id: chosenId,
    name: "Base URL set by hand",
    url: "",
    createdAt: 0,
    updatedAt: 0,
    steps: [],
    scriptPath: chosenScript,
    scriptEdited: true,
    sourceDir: path.join(shop, "tests"),
    sourceRoot: shop,
    baseUrl: "https://staging.shop.example.com/",
  });
  assertEqual(backfillBaseUrl(chosenId), null, "a base URL already on the record is never replaced");
  assertEqual(
    testStore.get(chosenId)?.baseUrl,
    "https://staging.shop.example.com/",
    "…and the user's own value survives, rather than reverting to the project's",
  );

  // Back to cancelling, so nothing after this can start an import by accident.
  setOpenDialogResult(null);
}

async function main(): Promise<void> {
  // ── 1. isInside boundary semantics ───────────────────────────────────────
  //
  // A prefix compare without the separator would call /a/scripts-evil a child
  // of /a/scripts, which is exactly the kind of near-miss containment check
  // that reads as correct and isn't.
  assert(isInside("/a/scripts", "/a/scripts/x.ts"), "a child is inside");
  assert(isInside("/a/scripts", "/a/scripts"), "a directory is inside itself");
  assert(!isInside("/a/scripts", "/a/scripts-evil/x.ts"), "a sibling with a shared PREFIX is not inside");
  assert(!isInside("/a/scripts", "/a/x.ts"), "a parent's other child is not inside");
  assert(!isInside("/a/scripts", "/a/scripts/../../x.ts"), "a path climbing back out is not inside");

  // ── 2. A project laid out the way a real one is ──────────────────────────
  const project = path.join(userData, "project");
  const outside = path.join(userData, "outside-the-project.js");
  write(outside, "// never ours to copy\n");
  write(path.join(project, "helpers", "util.js"), "export const u = 1;\n");
  write(path.join(project, "fixtures", "data.json"), "{}\n");
  // The spec sits deep, imports UP into the project (legitimate and supported),
  // and also tries to climb out of it entirely.
  write(
    path.join(project, "tests", "deep", "a.spec.ts"),
    [
      'import { test } from "@playwright/test";',
      'import "../../helpers/util.js";',
      'import "../../fixtures/data.json";',
      'import "../../../../../../../outside-the-project.js";',
      'test("t", async ({ page }) => { await page.goto("https://example.com"); });',
    ].join("\n") + "\n",
  );

  const found = scanDir(project);
  assertEqual(found.length, 1, "the project's one spec is found");
  assertEqual(found[0].root, project, "a found test carries the project ROOT, not just its own dir");

  // ── 3. Import it, via the same path importFromFiles/importFromGit use ────
  //
  // importFound is private, so this drives repairImports — the other caller of
  // copyRelativeImports, and the one that can be reached directly. It runs the
  // identical containment logic.
  const id = "11111111-1111-4111-8111-111111111111";
  const sandbox = importedSandboxDir(id);
  const scriptPath = path.join(sandbox, "tests", "deep", "a.spec.ts");
  write(scriptPath, found[0].content);
  const record: TestRecord = {
    id,
    name: "Imported",
    url: "https://example.com",
    createdAt: 0,
    updatedAt: 0,
    steps: [],
    scriptPath,
    scriptEdited: true,
    sourceDir: path.join(project, "tests", "deep"),
    sourceRoot: project,
  };
  testStore.save(record);

  const copied = repairImports(id);

  // ── 4. What landed, and what didn't ──────────────────────────────────────
  assertEqual(
    tree(sandbox),
    ["fixtures/data.json", "helpers/util.js", "tests/deep/a.spec.ts"],
    "siblings keep their PROJECT-relative positions, so the spec's own ../ imports resolve",
  );
  assert(
    copied.every((p) => isInside(sandbox, p)),
    "every copied file is inside the sandbox",
  );
  assert(
    !fs.existsSync(path.join(sandbox, "outside-the-project.js")),
    "the escaping import is not copied in under a flattened name either",
  );

  // The whole point: nothing was written outside the sandbox. The scripts dir
  // holds this test's sandbox and nothing else; userData still holds only what
  // the check itself put there.
  assertEqual(
    tree(getScriptsDir()).filter((p) => !p.startsWith("imported/")),
    [],
    "nothing was written into the scripts dir outside the sandbox",
  );
  assert(
    !fs.existsSync(path.join(userData, "recorder", "outside-the-project.js")),
    "…and nothing climbed to the scripts dir's PARENT, which is where it used to land",
  );

  // ── 5. What the record itself inherits from the source project ───────────
  //
  // Runs here, after the "nothing outside the sandbox" assertion above, because
  // it imports for real and fills the scripts dir with sandboxes of its own.
  await checkConfigInheritance();

  // ── 6. Symlinks are followed by statSync and copyFileSync ────────────────
  //
  // So a repo shipping `linked.js -> ~/.ssh/id_rsa` would have that file's
  // CONTENTS copied in — no `..` required, and the copy happens at import time,
  // before anything is run.
  {
    const secret = path.join(userData, "secret.txt");
    write(secret, "SECRET-CONTENT\n");
    const link = path.join(project, "tests", "deep", "linked.js");
    try {
      fs.symlinkSync(secret, link);
    } catch {
      console.log("skip symlink case (not permitted here)");
      finish();
      return;
    }
    write(
      path.join(project, "tests", "deep", "a.spec.ts"),
      'import { test } from "@playwright/test";\nimport "./linked.js";\ntest("t", async () => {});\n',
    );
    write(scriptPath, fs.readFileSync(path.join(project, "tests", "deep", "a.spec.ts"), "utf-8"));
    repairImports(id);
    assert(
      !fs.existsSync(path.join(sandbox, "tests", "deep", "linked.js")),
      "a sibling symlinked OUTSIDE the project is refused, not dereferenced and copied",
    );
    const leaked = tree(sandbox).some((p) => {
      try {
        return fs.readFileSync(path.join(sandbox, p), "utf-8").includes("SECRET-CONTENT");
      } catch {
        return false;
      }
    });
    assert(!leaked, "…and its contents are nowhere in the sandbox");
  }

  // ── 7. Deleting the test takes the sandbox ───────────────────────────────
  //
  // Removing only the spec would strand every sibling copied in with it, since
  // nothing else records that they were ever this test's.
  assert(fs.existsSync(sandbox), "the sandbox exists before the delete");
  testStore.remove(id);
  assert(!fs.existsSync(sandbox), "deleting an imported test removes its whole sandbox");

  finish();
}

/** Clean up and report the tally. Called on EVERY exit path: the symlink skip
 *  above used to `return` straight past this, so on a filesystem that refuses
 *  symlinks a genuine failure printed FAIL and still exited 0. */
function finish(): void {
  fs.rmSync(userData, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll import-sandbox checks passed");
}

await main();
