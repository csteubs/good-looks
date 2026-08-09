// Standalone check for the branch switcher's four load-bearing contracts.
//
// Three of these cannot be reached by a Vitest test, which is the whole reason
// this file exists:
//
//   1. The BUILD SCRIPT's own refusal of a hostile branch name. It is a
//      separate process with its own entry point, and the point of validating
//      there as well as in the service is that it holds when someone runs it by
//      hand. Driven here by actually running it.
//   2. ELECTRON_RUN_AS_NODE on the spawn. Under Electron `process.execPath` is
//      the Electron binary, so without the flag the switcher launches a second
//      copy of the app instead of running the build — a project-wide hard
//      constraint (CLAUDE.md). Exercising it for real would mean launching
//      Electron, so it is pinned at source.
//   3. Every relaunch carrying --gl-no-dev-url, and window-paths honouring it.
//      The failure it prevents is the worst-shaped one in this app: a window
//      that loads from a dev server that has already exited shows a BLANK
//      WINDOW and a CLEAN LOG. Nothing else in the toolchain can see this.
//   4. One copy of the branch validator, not two. The service and the script
//      run in different runtimes and cannot share a `.ts`, which is exactly the
//      situation that produces a transcribed regex — correct the day it is
//      written and silently divergent afterwards. Divergence here means the
//      script accepting a name the app would refuse.
//
// Run with: npm run check:branch-switch

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function source(relative: string): string {
  return readFileSync(join(root, relative), "utf-8");
}

// ── 1. The script refuses a hostile branch name, for real ─────────────

{
  const out = mkdtempSync(join(tmpdir(), "gl-branch-check-"));
  try {
    // `--upload-pack=…` is not a theoretical shape: git reads it as an option
    // and runs what it names. execFile spawns no shell, so this is not a shell
    // injection — which is precisely why quoting would not have saved it.
    const hostile = ["--upload-pack=touch /tmp/pwned", "../../../../tmp/evil", "a b", "a;id"];
    for (const branch of hostile) {
      let exitCode = 0;
      let stdout = "";
      try {
        stdout = execFileSync(
          process.execPath,
          [
            join(root, "scripts/switch-branch.mjs"),
            "--repo",
            root,
            "--branch",
            branch,
            "--out",
            out,
            "--json",
          ],
          { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch (err) {
        const e = err as { status?: number; stdout?: string };
        exitCode = e.status ?? 1;
        stdout = e.stdout ?? "";
      }
      assert(exitCode !== 0, `the build script refuses \`${branch}\` with a non-zero exit`);
      assert(
        stdout.includes('"ok":false'),
        `the build script reports \`${branch}\` as a failure rather than proceeding`,
      );
    }
    // Nothing was created for any of them. A refusal that still made the
    // directory would mean the check ran after the side effect.
    assert(
      execFileSync("ls", ["-A", out], { encoding: "utf-8" }).trim() === "",
      "a refused branch name leaves nothing behind in the builds root",
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

// ── 2. Spawns run as node, not as a second copy of the app ────────────

{
  const switcher = source("main/services/branch-switcher.ts");
  assert(
    /ELECTRON_RUN_AS_NODE:\s*"1"/.test(switcher),
    "the switcher spawns the build script with ELECTRON_RUN_AS_NODE=1",
  );
  assert(
    /spawn\(\s*process\.execPath/.test(switcher),
    "…and spawns process.execPath, which is what makes that flag necessary",
  );
  // The script spawns npm and git in turn. Inheriting the flag would hand it to
  // a real node, which is harmless today and exactly the sort of inherited
  // setting that produces an inexplicable failure two layers down.
  assert(
    /delete env\.ELECTRON_RUN_AS_NODE/.test(source("scripts/switch-branch.mjs")),
    "the build script strips ELECTRON_RUN_AS_NODE before spawning npm and git",
  );
}

// ── 3. A relaunch never inherits a dead dev server ────────────────────

{
  const switcher = source("main/services/branch-switcher.ts");
  const paths = source("main/windows/window-paths.ts");

  // One relaunch path builds the args for both cases (branch and home), so
  // "every relaunch" is checkable as "the one arg list always includes it".
  const args = /const args = \[appPath, NO_DEV_URL_ARG\]/.test(switcher);
  assert(args, "every relaunch passes --gl-no-dev-url, including the one back to the checkout");
  assert(
    (switcher.match(/app\.relaunch\(/g) ?? []).length === 1,
    "…and there is exactly one relaunch call site, so that cannot be half-true",
  );
  assert(
    /process\.argv\.includes\(NO_DEV_URL_ARG\)[\s\S]{0,80}GOOD_LOOKS_DEV_URL/.test(paths),
    "window-paths ignores GOOD_LOOKS_DEV_URL when the flag is present",
  );
}

// ── 4. One branch validator, shared — not two that drift ──────────────

{
  const script = source("scripts/switch-branch.mjs");
  assert(
    /from "\.\.\/shared\/branch-paths\.mjs"/.test(script),
    "the build script imports the branch validator from shared/, rather than carrying a copy",
  );
  assert(
    /branchNameProblem/.test(script) && /worktreeDirFor/.test(script),
    "…and uses both halves of it: the name rule and the containment rule",
  );
  // The shape a transcribed copy takes. A second character class in the script
  // means the two runtimes have started disagreeing about what a branch is.
  assert(
    !/\[A-Za-z0-9\._\/-\]/.test(script),
    "the build script does not define its own branch-name character class",
  );
  const service = source("main/services/branch-switcher.ts");
  assert(
    /branchNameProblem/.test(service),
    "the service validates too — the script is a second line, not the only one",
  );
}

// ── 5. The browser preview says so, rather than pretending ────────────

{
  const bridge = source("renderer/dev/preview-bridge.ts");
  assert(
    /"branches:status":[\s\S]{0,400}available:\s*false/.test(bridge),
    "the browser preview answers branches:status with available: false",
  );
  // The sidebar entry is what makes the feature reachable, and it must be
  // conditional or the preview shows a route that cannot work.
  assert(
    /branchesAvailable \? \(/.test(source("renderer/main/library-sidebar.tsx")),
    "the sidebar offers Branches only when the backend says it is available",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll branch-switch checks passed.");
