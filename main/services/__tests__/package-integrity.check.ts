// Standalone check for the two guards around `npm run package`.
//
// The failure they exist for: packaging from a worktree bootstrapped by
// `scripts/bootstrap-worktree.mjs` produces a BROKEN .app and exits 0.
// electron-builder cannot walk a symlinked `node_modules`, so it collects the
// direct dependencies and none of the ~175 packages below them, prints
// `cannot find path for dependency` — and succeeds. The bundle ships
// `@playwright/test` without `playwright` or `playwright-core`, so the app
// launches perfectly and every test run fails, which is the first moment
// anybody finds out.
//
// Why this is a check script and not a Vitest test:
//
//   1. The guards are a separate `.mjs` process with their own entry point,
//      and the point of them is what happens when a HUMAN runs `npm run
//      package`. Driven here by actually running the script, against fixture
//      trees on disk — the same shape as `check:branch-switch`.
//   2. The load-bearing case is a bundle whose DIRECT dependencies are all
//      present and whose transitive ones are not. A check that only looked at
//      `dependencies` would go green on the exact bug being guarded, so the
//      fixture is built to that shape deliberately.
//   3. A guard nothing invokes is worse than no guard, so the wiring in
//      package.json is pinned here too.
//
// Run with: npm run check:package-integrity

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const script = join(root, "scripts/verify-package.mjs");

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

/** Run the real script and report how it exited, with everything it printed. */
function run(args: string[]): { code: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function writePackage(dir: string, json: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(json));
}

/**
 * The packages the script promises by name, read OUT OF THE SCRIPT rather than
 * transcribed. A second copy of this list would be right the day it was written
 * and silently divergent afterwards — and the direction it fails is the fixture
 * quietly not covering a package the script still claims to guard.
 */
function runtimeCriticalNames(): string[] {
  const src = source("scripts/verify-package.mjs");
  const block = /const RUNTIME_CRITICAL = \[([\s\S]*?)\n\];/.exec(src);
  if (!block) throw new Error("Could not find RUNTIME_CRITICAL in scripts/verify-package.mjs");
  return [...block[1].matchAll(/\[\s*"([^"]+)"/g)].map((m) => m[1]);
}

const criticals = runtimeCriticalNames();

// ── 1. The list still names the packages whose absence breaks runs ────

{
  // Pinned against the runner's OWN resolution, so the two cannot drift into a
  // guard that protects packages the app no longer looks for. The runner finds
  // the CLI by path inside node_modules — which is exactly why a bundler can
  // say nothing about whether it is there.
  const runner = source("main/services/playwright-runner.ts");
  assert(
    /"@playwright", "test", "package.json"/.test(runner),
    "the runner still locates node_modules by looking for @playwright/test on disk",
  );
  for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
    assert(criticals.includes(name), `the guard names \`${name}\` as runtime-critical`);
  }
  // Every name on the list must be one the runner actually joins onto a path.
  // A name that is merely imported does not belong here — the bundler would
  // have failed on it long before packaging, and padding the list with those
  // makes it look like it covers more than it does.
  for (const name of criticals) {
    const asPathSegments = new RegExp(`"${name.split("/").join('", "')}"`);
    assert(
      asPathSegments.test(runner),
      `…and \`${name}\` is a package the runner builds a path to, which is why a bundler cannot vouch for it`,
    );
  }
}

// ── 2. Preflight: a symlinked node_modules is refused ─────────────────

{
  const real = mkdtempSync(join(tmpdir(), "gl-package-real-"));
  const linked = mkdtempSync(join(tmpdir(), "gl-package-linked-"));
  const bare = mkdtempSync(join(tmpdir(), "gl-package-bare-"));
  try {
    writePackage(real, { name: "fixture" });
    mkdirSync(join(real, "node_modules"));

    writePackage(linked, { name: "fixture" });
    // The precise thing `npm run bootstrap` creates: the root itself is a link.
    execFileSync("ln", ["-s", join(real, "node_modules"), join(linked, "node_modules")]);

    writePackage(bare, { name: "fixture" });

    const ok = run(["--preflight", "--root", real]);
    assert(ok.code === 0, "preflight passes when node_modules is a real directory");

    const bad = run(["--preflight", "--root", linked]);
    assert(bad.code !== 0, "preflight refuses when node_modules is a symlink");
    assert(
      /symlink/i.test(bad.output) && /install/.test(bad.output),
      "…and says what it is and how to fix it, rather than only that it failed",
    );

    const none = run(["--preflight", "--root", bare]);
    assert(none.code !== 0, "preflight refuses when there is no node_modules at all");
  } finally {
    for (const dir of [real, linked, bare]) rmSync(dir, { recursive: true, force: true });
  }
}

// ── 3. Verify: the bundle is asked the runtime question ───────────────

/**
 * A miniature project plus its packaged bundle.
 *
 * `alpha` is a DIRECT dependency; `beta` is reachable only through it and
 * `gamma` only through `beta`. That layering is the whole point: the real bug
 * shipped every direct dependency and nothing deeper, so a fixture without a
 * transitive level cannot tell a working guard from a broken one.
 *
 * `gamma` is nested under `beta` in the source tree and hoisted to the top
 * level in the bundle — npm produces both layouts, both are correct, and a
 * check that compared directory listings instead of resolving would call this
 * a failure.
 */
function buildFixture(omitFromBundle: string[] = [], withDist = true): string {
  const dir = mkdtempSync(join(tmpdir(), "gl-package-fixture-"));
  const deps: Record<string, string> = { alpha: "1.0.0" };
  for (const name of criticals) deps[name] = "1.0.0";
  writePackage(dir, { name: "fixture", dependencies: deps });

  const nm = join(dir, "node_modules");
  writePackage(join(nm, "alpha"), { name: "alpha", dependencies: { beta: "1.0.0" } });
  writePackage(join(nm, "beta"), { name: "beta", dependencies: { gamma: "1.0.0" } });
  writePackage(join(nm, "beta", "node_modules", "gamma"), { name: "gamma" });
  // devDependencies are not shipped, so one here proves the closure ignores them.
  writePackage(join(nm, "toolchain"), { name: "toolchain" });
  for (const name of criticals) writePackage(join(nm, name), { name });

  if (!withDist) return dir;

  const app = join(dir, "dist", "mac-arm64", "Fixture.app", "Contents", "Resources", "app");
  mkdirSync(app, { recursive: true });
  cpSync(join(dir, "package.json"), join(app, "package.json"));
  const bundled = join(app, "node_modules");
  for (const name of ["alpha", "beta", ...criticals]) {
    if (omitFromBundle.includes(name)) continue;
    writePackage(join(bundled, name), { name });
  }
  if (!omitFromBundle.includes("gamma")) writePackage(join(bundled, "gamma"), { name: "gamma" });
  return dir;
}

{
  const complete = buildFixture();
  try {
    const ok = run(["--verify", "--root", complete]);
    assert(ok.code === 0, "verify passes on a bundle carrying the whole dependency closure");
    assert(
      !/toolchain/.test(ok.output),
      "…and does not demand devDependencies, which are never shipped",
    );
  } finally {
    rmSync(complete, { recursive: true, force: true });
  }
}

{
  // The reported bug, in miniature: every direct dependency present, the
  // transitive ones gone.
  const shallow = buildFixture(["beta", "gamma", "playwright", "playwright-core"]);
  try {
    const bad = run(["--verify", "--root", shallow]);
    assert(
      bad.code !== 0,
      "verify fails when only the DIRECT dependencies were bundled — the reported bug",
    );
    assert(/beta/.test(bad.output), "…and names a missing transitive package");
    assert(
      /required internally by @playwright\/test/.test(bad.output),
      "…and says what breaks, not just that something is absent",
    );
    assert(
      /symlink/.test(bad.output),
      "…and points at the usual cause, since the fix is not in the bundle",
    );
  } finally {
    rmSync(shallow, { recursive: true, force: true });
  }
}

{
  const noBundle = buildFixture([], false);
  try {
    const bad = run(["--verify", "--root", noBundle]);
    assert(bad.code !== 0, "verify fails when packaging produced no bundle at all");
  } finally {
    rmSync(noBundle, { recursive: true, force: true });
  }
}

// ── 4. The guards are actually wired into `npm run package` ───────────

{
  const pkg = JSON.parse(source("package.json")) as { scripts: Record<string, string> };
  const packageScript = pkg.scripts.package ?? "";

  assert(
    /verify-package\.mjs --preflight/.test(packageScript),
    "`npm run package` runs the preflight",
  );
  assert(
    /verify-package\.mjs --verify/.test(packageScript),
    "`npm run package` runs the post-package verification",
  );
  // Order is the whole value of the preflight: after the build it has saved
  // nobody anything, and after electron-builder it is the other check.
  assert(
    packageScript.indexOf("--preflight") < packageScript.indexOf("electron-builder") &&
      packageScript.indexOf("electron-builder") < packageScript.indexOf("--verify"),
    "…in that order: preflight before the build, verification after electron-builder",
  );
  // `&&` and not `;`, or a failed guard is a printed complaint the exit code
  // does not carry — which is the failure mode being fixed.
  assert(
    !/;\s*(node scripts\/verify-package|npm run build|electron-builder)/.test(packageScript),
    "…chained with && so a refusal actually stops the build",
  );
  assert(
    /check:package-integrity/.test(pkg.scripts["test:checks"] ?? ""),
    "this check runs as part of test:checks",
  );
}

// ── 5. The trap says so where it is set ───────────────────────────────

{
  // bootstrap-worktree is what creates the symlink, so it is the one place a
  // human is guaranteed to read at the moment the trap is armed.
  const bootstrap = source("scripts/bootstrap-worktree.mjs");
  // `npm run package` and not /packag/i: the loose form matches
  // "package-lock.json", which this file has always contained, so it would
  // have gone green before the note was written and stayed green if it were
  // deleted. It did, in draft — hence the specificity.
  assert(
    /npm run package/.test(bootstrap),
    "bootstrap-worktree names `npm run package` as needing a real install",
  );
  assert(
    /npm run package/.test(source("CLAUDE.md").split("### Environment gotchas")[1] ?? ""),
    "…and so does the worktree note in CLAUDE.md, which is where the rule is looked up",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll package-integrity checks passed.");
