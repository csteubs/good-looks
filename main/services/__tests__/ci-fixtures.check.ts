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

import { readdirSync, readFileSync } from "node:fs";
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
  // Enumerated by NAME rather than counted. The counted version asserted
  // `>= 5` against a `const wants[A-Za-z]+` pattern that cannot match
  // `wantsA11y` — there is a digit in it — so it was silently proving four
  // gates while reading as five, and passed at exactly its threshold. A count
  // is a check you cannot tell has stopped covering something.
  const GATES = ["wantsScreenshots", "wantsA11y", "wantsLogs", "wantsSettle", "wantsUserPage"];
  for (const gate of GATES) {
    assert(
      new RegExp(`const ${gate} =\\s*!imported`).test(runner),
      `${gate} is guarded by !imported`,
    );
  }
  // And the list is the whole list: a gate added without a row here would be
  // unguarded and unnoticed, which is the failure the enumeration replaces.
  const declared = (runner.match(/const (wants[A-Za-z0-9]+) =/g) ?? []).map((m) =>
    m.slice("const ".length, -" =".length),
  );
  const unlisted = declared.filter((d) => !GATES.includes(d));
  assert(
    unlisted.length === 0,
    `every capability gate in the runner is listed here (${unlisted.join(", ") || "none"})`,
  );
}

// ── 5. Auto-Heal's SWITCH, its MAP and the WRITER are one decision ───────
//
// R49, and the reason this section was rewritten. Healing needs three things
// that live in three places: the switch (`GLAZE_HEAL`), the map file
// (`GLAZE_HEAL_MAP`), and something that actually WRITES that file. The fixture
// does nothing whatsoever without all three — `if (!entry || !entry.probe ||
// …) throw err` is the first line of every patched action, so a missing map is
// not a degraded heal, it is no heal.
//
// R8 set the switch, pointed the map at `<testId>.heal.json`, and shipped no
// writer. That filename's only occurrence in the repository was the assignment
// itself. Every unattended run therefore installed healing, patched every
// locator factory, healed nothing, and recorded no evidence of having tried —
// while `ran.autoHeal` reported the capability as present. Nothing failed. The
// old assertion here pinned the switch and never the map, so the gate was green
// throughout.
//
// So this asserts the IMPLICATION, in both arms, rather than the state. The
// "off" arm is not a skip: it has its own thing to prove — that the other two
// halves are absent too, because a `GLAZE_HEAL_MAP` left sitting beside a
// switched-off gate is precisely what the next person re-enables in isolation.
{
  const policy = CI_FIXTURE_POLICY.find((p) => p.capability === "Auto-Heal");
  // Anything but the literal "0". A ternary counts as on: `wantsHeal ? "1" :
  // "0"` is exactly what shipped, and reading it as off is how this was missed.
  const switchOn = /env\.GLAZE_HEAL = (?!"0";)/.test(runner);
  assert(
    switchOn === (policy?.onInCi !== false),
    `the written policy and the runner agree about healing (policy ${String(policy?.onInCi)}, ` +
      `switch ${switchOn ? "on" : "off"})`,
  );

  if (switchOn) {
    // THE ARM THAT WOULD HAVE CAUGHT R49. A switch without a map is a run that
    // reports healing and does none.
    assert(
      /GLAZE_HEAL_MAP/.test(runner),
      "healing is on, so the runner points the fixture at a map file",
    );
    assert(
      /healMapFileName\(/.test(runner),
      "…named through shared/heal-artifacts.mjs, so it cannot be a second spelling",
    );
    // And the file has to EXIST, which means this process builds one. The map
    // is per-step and carries a probe script; nothing else can stand in for it.
    assert(
      /buildHealMap|healMap[A-Za-z]*\s*=\s*[^;]*\n?[\s\S]{0,400}?writeFileSync/.test(runner),
      "…and writes it, rather than naming a file nothing produces",
    );
  } else {
    // Off, wholly. Each of these being absent is what makes turning it back on
    // a decision someone has to make on purpose.
    assert(
      !/GLAZE_HEAL_MAP/.test(runner),
      "healing is off, so the runner names no map file for the fixture to miss",
    );
    assert(
      !/GLAZE_HEAL_DIR/.test(runner),
      "…and no heal directory either — a half-set gate is what R49 was",
    );
    // And the run has to SAY so. `describeRun` carries the sentence; a
    // `ran.autoHeal` that is anything but false suppresses it, which is how a
    // capability nobody had got reported as one everybody did.
    // EVERY occurrence, enumerated. `!/autoHeal:\s*(?!false)/` was the first
    // draft and it can never fire: `\s*` backtracks to zero width and the
    // lookahead then passes on the space. A negative assertion that cannot fail
    // is the shape this whole section exists to stop.
    const reported = runner.match(/autoHeal:\s*[^,\n]*/g) ?? [];
    assert(
      reported.length > 0 && reported.every((r) => /autoHeal:\s*false/.test(r)),
      `every \`ran.autoHeal\` this runner reports is false, so describeRun says it was skipped ` +
        `(${reported.join(" | ") || "none reported at all"})`,
    );
    assert(
      /Run-time Auto-Heal/.test(code("mcp/run-plan.mjs")),
      "…and describeRun has the sentence to say it with",
    );
  }

  // True under both arms. Applying is the plan's one explicit prohibition: it
  // would edit a tests.json that dies with the container, so the run would
  // report a heal it did not keep and the next run would fail the same way. It
  // holds by construction rather than by a flag — this process has no code that
  // reads heals back.
  assert(
    !/writeScript|updateSteps|applyHeal|healJournal/.test(runner),
    "nothing in the MCP runner writes a heal back to the test",
  );
}

// ── 5b. A heal artifact is named in exactly one place ────────────────────
//
// The defect above was a FILENAME disagreement and nothing more: two writers,
// two spellings, no error. `shared/heal-artifacts.mjs` is the single spelling,
// and this is what stops a third appearing — a check on the map's *content*
// would not have caught R49, because there was no content, and no file.
//
// Tests are excluded on purpose: `heal-fixture.test.ts` builds its own map in a
// temp directory to feed the fixture, which is a fixture input rather than a
// second name for the run's artifact.
{
  const SPELLING = /\.heal-map\.json|\.heal\.json|\$\{[^}]+\}\.heal\b/;
  const roots = ["main", "mcp", "cli", "shared", "renderer", "bin", "scripts"];
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "__tests__") continue;
        walk(rel);
        continue;
      }
      if (!/\.(ts|tsx|mjs|mts)$/.test(e.name)) continue;
      if (/\.test\.(ts|tsx)$/.test(e.name)) continue;
      if (rel === "shared/heal-artifacts.mjs" || rel === "shared/heal-artifacts.d.mts") continue;
      if (SPELLING.test(code(rel))) offenders.push(rel);
    }
  };
  for (const r of roots) walk(r);
  assert(
    offenders.length === 0,
    `a heal artifact is named only in shared/heal-artifacts.mjs (${offenders.join(", ") || "none"})`,
  );
  // The other half: the app, which is the process that DOES write one, reaches
  // it through that module. Without this the assertion above passes on an app
  // runner that has stopped naming a heal map at all.
  assert(
    /healMapFileName\(recordId\)/.test(appRunner) && /healDirName\(recordId\)/.test(appRunner),
    "the app runner names both heal artifacts through shared/heal-artifacts.mjs",
  );
  assert(
    /shared\/heal-artifacts\.mjs/.test(appRunner),
    "…and imports them rather than redeclaring the shape",
  );
}

// ── 6. What is OFF is off for a stated reason ────────────────────────────
//
// Both of these will stop being true, and the policy names what would change
// them — which is the difference between a decision and an omission.
{
  const off = CI_FIXTURE_POLICY.filter((p) => p.onInCi === false);
  assert(off.length === 3, `exactly three capabilities are off in CI (${off.length})`);
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
  // The third joined them through R49, and both name the SAME piece of work —
  // which is the useful part of writing the reason down: two capabilities
  // waiting on one extraction is an argument for doing that extraction, and two
  // unexplained `false`s are not. Asserted on the row id rather than on the
  // phrase "extraction", so it keeps holding once that work has LANDED and the
  // reason changes from "blocked on R51" to "R51 is in, this is unbuilt" — a
  // check that goes red for being satisfied teaches people to edit the check.
  const waited = off.filter(
    (p) => p.capability === "Auto-Heal" || p.capability === "overlay dismissal",
  );
  assert(waited.length === 2, `both locator-engine capabilities are listed (${waited.length})`);
  assert(
    waited.every((p) => /R51/.test(p.why)),
    "…and both name R51, so the two are visibly one job rather than two omissions",
  );
  assert(
    off.some((p) => p.capability === "Auto-Heal" && /R49/.test(p.why)),
    "…and names the defect it was turned off by, so nobody re-enables it as an oversight",
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
