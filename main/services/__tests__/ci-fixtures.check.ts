// The fixtures an unattended run gets, and the ones it deliberately does not (R8).
//
// WHY THIS IS A CHECK. Every failure here is silent in the worst way — the run
// still finishes, still reports pass or fail, and is simply less capable than
// the same test run from the app. Nothing throws. The team's conclusion is that
// CI is flaky, which is the exact outcome the runner plan says makes a CI
// integration worse than none.
//
// The sharpest example, and the bug that started this: `glaze-runtime.mjs` is
// IMPORTED by any generated spec that uses a helper, so it is a dependency of
// the spec rather than a feature of the run. Only the app wrote it, which meant
// an MCP or CLI run worked exactly when the app had happened to run that test on
// the same machine first — and failed at module load on every fresh CI
// container, reporting "no tests found" rather than a missing fixture.
//
// Run with: npm run check:ci-fixtures

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ALWAYS_WRITTEN,
  CAPABILITY_FIXTURES,
  CI_FIXTURE_POLICY,
  redirectToCaptureFixture,
} from "../../../shared/run-fixtures.mjs";

const root = process.cwd();
let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function code(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

const runner = code("mcp/run-tests.mjs");
const appRunner = code("main/services/playwright-runner.ts");

// ── 1. The runtime is written unconditionally ────────────────────────────
{
  assert(
    ALWAYS_WRITTEN.some((f) => f.file === "glaze-runtime.mjs"),
    "the spec runtime is in the ALWAYS list, not behind a capability gate",
  );
  // The gate would be the regression: a generated spec importing a helper does
  // not load without it, and "did the user ask for screenshots" has nothing to
  // do with whether its import resolves.
  assert(
    /ensureRunFixtures\(scriptsDir, \{ capabilities: anyCapability \}\)/.test(runner),
    "the MCP runner writes the always-set on every run, capabilities or not",
  );
  // Anchored on the CALL, not on `ensureRunFixtures(` — that also matches the
  // function's own definition, which sits above everything and made the first
  // draft of this assertion pass no matter where the call went. Caught by
  // moving the call and watching nothing happen.
  const atCall = runner.indexOf("ensureRunFixtures(scriptsDir, { capabilities: anyCapability })");
  const atRedirect = runner.indexOf("redirectToCaptureFixture(original)");
  assert(
    atCall > 0 && atRedirect > 0 && atCall < atRedirect,
    "…and writes them BEFORE redirecting the spec, or the redirect points at nothing",
  );
}

// ── 2. Both runners write the same set ───────────────────────────────────
//
// Two processes writing one scripts directory, whichever ran last winning — the
// shape `mcp/playwright-config.mjs` already records. A file one writes and the
// other does not is a run that behaves differently for no reason a user can see.
{
  // Asserted on the SOURCE each runner imports, not on the filename: the app
  // names these through constants (`HEAL_FIXTURE_FILE`), so a filename match
  // would be a check that passes on prose. What has to be true is that both
  // read the same module in `shared/`, which is what makes the set one set.
  for (const mod of [
    "glaze-runtime-source",
    "step-reporter-source",
    "capture-fixture-source",
    "heal-fixture-source",
    "settle-fixture-source",
    "signature-fixture-source",
    "user-page-fixture-source",
  ]) {
    assert(
      new RegExp(`shared/${mod}\\.mjs`).test(appRunner),
      `the app runner writes ${mod} from shared/`,
    );
    assert(
      new RegExp(`shared/${mod}\\.mjs`).test(runner) ||
        new RegExp(`\\b${mod.replace(/-/g, "")}\\b`, "i").test(runner) ||
        /run-fixtures\.mjs/.test(runner),
      `…and the MCP runner reaches it through the same table`,
    );
  }
  // The capture fixture imports the other four, so a partial set is an import
  // error rather than a disabled feature. Pinned as a set, not per file.
  const names = CAPABILITY_FIXTURES.map((f) => f.file);
  for (const needed of ["glaze-settle.mjs", "glaze-signature.mjs", "glaze-user-page.mjs"]) {
    assert(
      names.includes(needed),
      `${needed} ships with the capture fixture — it imports it, so a partial set will not load`,
    );
  }
}

// ── 3. The redirect preserves line numbers ───────────────────────────────
//
// Every screenshot's step attribution and the whole step line map are built from
// them, so a redirect that reflowed the file would misattribute silently.
{
  const spec = 'import { test, expect } from "@playwright/test";\nimport x from "./y.mjs";\ntest("a", async () => {});\n';
  const out = redirectToCaptureFixture(spec);
  assert(out !== null, "a spec importing @playwright/test is redirected");
  assert(
    out !== null && out.split("\n").length === spec.split("\n").length,
    "…with the same number of lines, so the step line map still points at the right steps",
  );
  assert(
    out !== null && out.includes('from "./glaze-capture.mjs"') && !out.includes("@playwright/test"),
    "…and the import actually moved",
  );
  assert(
    redirectToCaptureFixture('import { test } from "./elsewhere.mjs";') === null,
    "a spec with nothing to redirect is left alone rather than rewritten",
  );
}

// ── 4. An imported project is never instrumented ─────────────────────────
//
// `sourceDir` means someone else's Playwright project. Redirecting its
// `@playwright/test` import would rewrite their code rather than instrument
// ours, which is the import sandbox's whole premise one level up.
{
  assert(
    /const imported = Boolean\(test\.sourceDir\)/.test(runner),
    "the MCP runner asks whether the spec is an imported project",
  );
  const gates = runner.match(/const wants[A-Za-z]+ =\s*\n?\s*!imported/g) ?? [];
  assert(
    gates.length >= 5,
    `every capability gate is guarded by !imported (${gates.length} found)`,
  );
}

// ── 5. Auto-Heal suggests; it never applies ──────────────────────────────
//
// The plan's one explicit prohibition. Applying would edit a tests.json that
// dies with the container — so the run would report a heal it did not keep, and
// the next run would fail the same way.
{
  assert(
    /env\.GLAZE_HEAL = wantsHeal \? "1" : "0";/.test(runner),
    "run-time healing is ON for an unattended run",
  );
  // The writeback is what must be absent, and it is absent by construction
  // rather than by a flag: this process has no code that reads heals back.
  assert(
    !/writeScript|updateSteps|applyHeal|healJournal/.test(runner),
    "…and nothing in the MCP runner writes a heal back to the test",
  );
  const policy = CI_FIXTURE_POLICY.find((p) => p.capability === "Auto-Heal");
  assert(policy?.onInCi === "suggest only", "the written policy says suggest only");
}

// ── 6. What is OFF is off for a stated reason ────────────────────────────
//
// Both of these will stop being true, and the policy names what would change
// them — which is the difference between a decision and an omission.
{
  const off = CI_FIXTURE_POLICY.filter((p) => p.onInCi === false);
  assert(off.length === 2, `exactly two capabilities are off in CI (${off.length})`);
  for (const p of off) {
    assert(
      p.why.length > 40,
      `"${p.capability}" says why it is off rather than just that it is`,
    );
  }
  assert(
    off.some((p) => p.capability === "signature headers" && /R7/.test(p.why)),
    "signature headers name R7 as what would turn them on",
  );
  assert(
    off.some((p) => p.capability === "overlay dismissal" && /locator engine/.test(p.why)),
    "overlay dismissal names the locator-engine extraction as its blocker",
  );
}

// ── 7. The run reports what it actually did ──────────────────────────────
//
// `describeRun` used to say every capability was skipped, because it always
// was. Now that it sometimes is not, a caller has to tell it — and the default
// stays "none", so a caller predating this reports exactly what it did before.
{
  const plan = code("mcp/run-plan.mjs");
  assert(/ran = \{\},/.test(plan), "describeRun takes what the run actually got");
  const guarded = (plan.match(/&& !ran\./g) ?? []).length;
  assert(
    guarded >= 5,
    `every capability note is conditional on the run not having it (${guarded} of 5)`,
  );
  assert(
    /ran: result\.ran/.test(code("mcp/server.mjs")),
    "run_test reports it off the result rather than re-deriving it",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll CI-fixture checks passed.");
