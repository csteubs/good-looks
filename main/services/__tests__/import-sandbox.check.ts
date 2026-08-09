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

const { importedSandboxDir, isInside, repairImports, scanDir } = await import(
  "../import-service.js"
);
const { testStore, getScriptsDir } = await import("../test-store.js");

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

function main(): void {
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

  // ── 5. Symlinks are followed by statSync and copyFileSync ────────────────
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

  // ── 6. Deleting the test takes the sandbox ───────────────────────────────
  //
  // Removing only the spec would strand every sibling copied in with it, since
  // nothing else records that they were ever this test's.
  assert(fs.existsSync(sandbox), "the sandbox exists before the delete");
  testStore.remove(id);
  assert(!fs.existsSync(sandbox), "deleting an imported test removes its whole sandbox");

  fs.rmSync(userData, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll import-sandbox checks passed");
}

main();
