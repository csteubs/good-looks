// The CLI's exit-code contract, asserted against the REAL BINARY (R2).
//
// WHY THIS SPAWNS RATHER THAN READS. `check:mcp-boot` exists because nothing
// booted the MCP server: every other `check:mcp-*` read the source or imported
// the pure modules, and all of them stayed green for the six months the server
// threw at module load and no tool was reachable. A CLI has exactly that shape
// — one entry point, a `bin` field, an argv contract — and the same blind spot.
// A source-level check here would pass against a `bin/good-looks.mjs` with a
// syntax error in it.
//
// So every case below runs `node bin/good-looks.mjs …` for real and reads the
// process's own exit code. What that proves that a unit test cannot: that the
// file parses, that its imports resolve from `bin/`, that the async entry point
// actually sets `process.exitCode`, and — the one that bites — that the output
// SURVIVES being piped. `process.exit(n)` truncates a piped stdout, and this
// check reads stdout through a pipe, so a regression to it shows up here as
// empty output rather than as nothing at all.
//
// Codes 0 and 1 need a browser and a real run, which no check in this chain
// does. They are covered as a pure mapping — every arm including those two — in
// `main/services/cli-exit.test.ts`, and the two REFUSAL codes are driven
// end-to-end here. That split is deliberate and stated so nobody reads this
// file as complete coverage of the contract on its own.
//
// Run with: npm run check:cli-exit

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT } from "../../../cli/exit.mjs";
import { USERDATA_OVERRIDE_ENV } from "../../../shared/user-data-rules.mjs";

const root = process.cwd();
const BIN = join(root, "bin", "good-looks.mjs");

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

/** A throwaway library the CLI can resolve, through the SAME override the app
 *  and the MCP honour. Building one here rather than pointing at the developer's
 *  real store is what makes this runnable on a CI runner that has never opened
 *  the app — the reason `check:mcp-boot` does the same. */
function makeStore(tests: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "gl-cli-"));
  const recorder = join(dir, "recorder");
  mkdirSync(recorder, { recursive: true });
  writeFileSync(join(recorder, "tests.json"), JSON.stringify(tests), "utf8");
  writeFileSync(join(recorder, "recorder-settings.json"), "{}", "utf8");
  // Present and EMPTY: `isBrowserInstalled` reads this directory's listing, so
  // an empty one is "no browser installed" rather than "cannot tell".
  mkdirSync(join(recorder, "browsers"), { recursive: true });
  mkdirSync(join(recorder, "scripts"), { recursive: true });
  return dir;
}

/** Run the CLI and report what the OS saw. `execFileSync` throws on a non-zero
 *  exit, which is the case under test, so the status is read off the error. */
function runCli(args: string[], dataDir: string): { code: number; stdout: string; stderr: string } {
  const env = { ...process.env, [USERDATA_OVERRIDE_ENV]: dataDir };
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const ONE_TEST = [
  {
    id: "t-one",
    name: "One",
    url: "https://example.com",
    steps: [],
    tags: ["smoke"],
    scriptPath: "/nonexistent/one.spec.ts",
    createdAt: 1,
    updatedAt: 1,
  },
];

const store = makeStore(ONE_TEST);

try {
  // ── The command answers at all ─────────────────────────────────────────
  {
    const r = runCli(["--help"], store);
    assert(r.code === EXIT.PASSED, "`--help` exits 0 — an explicit help request is a success");
    // The pipe assertion. `process.exit()` in the entry point makes this empty
    // while a terminal run still looks perfect.
    assert(
      r.stdout.includes("good-looks"),
      r.stdout.length > 0
        ? "…and its output survives being piped"
        : "…but its output was EMPTY through a pipe — process.exit() truncates stdout",
    );
    assert(
      r.stdout.includes(`${EXIT.NO_MATCH}  the selector matched no tests`),
      "…and prints the exit-code contract, from the same table the code uses",
    );
  }

  // ── 2: the selector matched nothing ────────────────────────────────────
  //
  // THE code this contract exists for. Every one of these selects zero tests
  // from a library that is NOT empty, which is the silently-green pipeline: the
  // summary of a suite of zero is the same shape as the summary of a clean pass,
  // so without a distinct code the two are indistinguishable to a CI job. The
  // specific way a selector goes stale in this library is pinned below.
  for (const [label, args] of [
    ["a tag nothing carries", ["run", "--tag", "nope"]],
    ["a group nothing is in", ["run", "--group", "Nope"]],
    ["an id that does not exist", ["run", "--id", "t-missing"]],
  ] as const) {
    const r = runCli([...args], store);
    assert(r.code === EXIT.NO_MATCH, `exit ${EXIT.NO_MATCH} for ${label}`);
  }

  // …and it names what it actually looked for, which is the difference between
  // "no tests matched" and knowing the tag was renamed.
  {
    const r = runCli(["run", "--tag", "nope"], store);
    assert(r.stderr.includes('tag "nope"'), "…and the message names the selector that applied");
  }

  // THE PLAN'S OWN EXAMPLE, corrected to this codebase. §3.3 warns that renaming
  // a tag `smoke` → `Smoke` leaves a green pipeline testing nothing. That exact
  // case cannot happen here — `selectTests` folds tag case — but the asymmetry
  // beside it means the warning lands on FOLDERS instead: a folder name is
  // matched exactly (a tag is matched, a folder is displayed). So renaming a
  // folder's capitalisation is the real silently-empty selector in this library,
  // and it is the one worth pinning.
  {
    const cased = makeStore([{ ...ONE_TEST[0], group: "Checkout" }]);
    try {
      assert(
        runCli(["run", "--group", "checkout"], cased).code === EXIT.NO_MATCH,
        "a folder differing only in case matches nothing — folders are exact",
      );
      assert(
        runCli(["run", "--tag", "SMOKE"], cased).code !== EXIT.NO_MATCH,
        "…while a tag differing only in case still matches — tags fold case",
      );
    } finally {
      rmSync(cased, { recursive: true, force: true });
    }
  }

  // A visible test IS selectable — otherwise every assertion above would pass
  // against a CLI that matches nothing at all, which is the vacuous shape.
  {
    const r = runCli(["run", "--tag", "smoke"], store);
    assert(
      r.code !== EXIT.NO_MATCH,
      r.code !== EXIT.NO_MATCH
        ? "a tag the library DOES carry is not reported as an empty selection"
        : "a tag the library carries was reported as no match — the checks above prove nothing",
    );
  }

  // ── 3: the run could not start ─────────────────────────────────────────
  {
    // Selection succeeds, then the browser check fails: `recorder/browsers` is
    // empty in this fixture, so no engine is installed.
    const r = runCli(["run", "--tag", "smoke"], store);
    assert(r.code === EXIT.CANNOT_START, `exit ${EXIT.CANNOT_START} when the browser is missing`);
    assert(
      r.stderr.includes("not installed"),
      "…and says which engine, rather than failing inside Playwright",
    );
  }

  for (const [label, args] of [
    ["an unknown option", ["run", "--fail-fast"]],
    ["a flag given no value", ["run", "--tag"]],
    ["no selector at all", ["run"]],
    ["two selectors at once", ["run", "--all", "--tag", "smoke"]],
    ["an unknown browser", ["run", "--all", "--browser", "safari"]],
    ["an unknown speed", ["run", "--all", "--speed", "turbo"]],
    ["a non-numeric --parallel", ["run", "--all", "--parallel", "eight"]],
    ["an unknown command", ["frobnicate"]],
  ] as const) {
    const r = runCli([...args], store);
    assert(r.code === EXIT.CANNOT_START, `exit ${EXIT.CANNOT_START} for ${label}`);
  }

  // Never 0, and never 1. Both are the failure this contract is about: 0 is the
  // silently-green pipeline, and 1 sends someone to read the tests when the
  // problem is the invocation.
  {
    const r = runCli(["run", "--fail-fast"], store);
    assert(
      r.code !== EXIT.PASSED && r.code !== EXIT.FAILED,
      "a usage error is never reported as a pass or as a test failure",
    );
  }

  // ── `data-dir` answers the first question of a CI misconfiguration ──────
  {
    const r = runCli(["data-dir"], store);
    assert(r.code === EXIT.PASSED, "`data-dir` exits 0");
    assert(
      r.stdout.trim() === store,
      "…and prints the library the run would use, honouring the override",
    );
  }

  // ── An override at an empty directory is 2, not 3 ──────────────────────
  //
  // Worth pinning because it is the boundary between the two refusals and it is
  // not obvious. Setting the override is an ASSERTION that the library is
  // there, so `resolveDataDir` returns it without probing — a store with no
  // tests in it is then a selector that matched nothing, which is 2. Reading it
  // as 3 would tell a CI operator their setup is broken when their library is
  // merely empty.
  {
    const empty = mkdtempSync(join(tmpdir(), "gl-cli-empty-"));
    try {
      const r = runCli(["run", "--all"], empty);
      assert(
        r.code === EXIT.NO_MATCH,
        `exit ${EXIT.NO_MATCH} when the override names a directory with no tests in it`,
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }

  // ── No store ANYWHERE is 3, as a sentence ──────────────────────────────
  //
  // The genuine CI misconfiguration: nothing set, and nothing where the app
  // would have put it. `resolveDataDir` throws here — the only branch that
  // does — and the message names every path it looked in plus the override that
  // fixes it, because the reader is looking at a CI log with no other context.
  //
  // Driven by pointing HOME at an empty directory rather than by the override,
  // since the override is exactly what suppresses this branch.
  {
    const home = mkdtempSync(join(tmpdir(), "gl-cli-home-"));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
      delete env[USERDATA_OVERRIDE_ENV];
      delete env.XDG_CONFIG_HOME;
      let code = 0;
      let stderr = "";
      try {
        execFileSync(process.execPath, [BIN, "run", "--all"], {
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        const e = error as { status?: number; stderr?: string };
        code = e.status ?? -1;
        stderr = e.stderr ?? "";
      }
      assert(
        code === EXIT.CANNOT_START,
        `exit ${EXIT.CANNOT_START} when there is no library anywhere to read`,
      );
      assert(
        stderr.includes(USERDATA_OVERRIDE_ENV) && !stderr.includes("    at "),
        "…as a sentence naming the way out, not a stack trace from inside node_modules",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(store, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll CLI exit-code checks passed.");
