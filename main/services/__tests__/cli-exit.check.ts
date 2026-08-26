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
// Codes 0 and 1 need a browser, so the CONTRACT is covered as a pure mapping —
// every arm including those two — in `main/services/cli-exit.test.ts`, while the
// two REFUSAL codes are driven end-to-end here. That split is deliberate and
// stated so nobody reads this file as complete coverage of the contract on its
// own.
//
// The last section is the exception and does execute a real run, because what it
// asserts cannot be reached any other way — see "What a CLI run RECORDS about
// itself" below. It needs no browser: Playwright collects before it launches
// one, so a run whose spec is missing fails during collection, which is late
// enough to have written the record and early enough to need nothing installed.
//
// Run with: npm run check:cli-exit

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { EXIT } from "../../../cli/exit.mjs";
import { USERDATA_OVERRIDE_ENV } from "../../../shared/user-data-rules.mjs";
import {
  expectedBrowserDirs,
  type InstallableBrowser,
} from "../../../shared/browser-install.mjs";

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

/** The `<engine>-<revision>` directory names the BUNDLED Playwright would
 *  unpack, read from its own manifest through the app's shared rule. Read
 *  rather than hard-coded for the reason `shared/browser-install.mjs` exists:
 *  a name-prefix guess accepted the previous Playwright's build after the 1.62
 *  upgrade, and every run then launched a browser that was not there. */
function expectedRevisions(engine: InstallableBrowser): string[] {
  try {
    const manifest = readFileSync(
      join(root, "node_modules", "playwright-core", "browsers.json"),
      "utf8",
    );
    return expectedBrowserDirs(manifest, engine) ?? [];
  } catch {
    return [];
  }
}

/** Run the CLI and report what the OS saw. `execFileSync` throws on a non-zero
 *  exit, which is the case under test, so the status is read off the error. */
function runCli(
  args: string[],
  dataDir: string,
  extraEnv: Record<string, string | undefined> = {},
): { code: number; stdout: string; stderr: string } {
  const env = { ...process.env, [USERDATA_OVERRIDE_ENV]: dataDir, ...extraEnv };
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
      r.stdout.includes(`${EXIT.NO_MATCH}  the selector matched no tests`) &&
        r.stdout.includes(`${EXIT.CANNOT_START}  the run could not start, or nothing in it ran`),
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

  // ── `--dry-run` answers what WOULD run, and still refuses an empty one ──
  //
  // The whole value of a dry run is that it is trustworthy, and the only way it
  // can be is by planning through the same code the run uses. These assertions
  // are about the two ways it could quietly stop being that.
  {
    // 1. It answers on a machine with no browser. That is precisely when
    //    someone asks — a fresh CI container — and refusing until the
    //    environment is complete would make the flag useless when wanted.
    //    (This fixture's `recorder/browsers` is empty, so a REAL run here
    //    exits 3; the dry run must not.)
    const r = runCli(["run", "--tag", "smoke", "--dry-run"], store);
    assert(r.code === EXIT.PASSED, "a dry run answers even with no browser installed");
    assert(r.stdout.includes("Would run 1 test(s)"), "…and says what it would run");
    assert(
      r.stdout.includes("nothing was recorded"),
      "…and says plainly that nothing ran, which is the question being asked",
    );
    // …while still WARNING, because the real run will refuse.
    assert(
      r.stdout.includes("good-looks install chromium"),
      "…and still names the missing browser a real run would stop on",
    );
  }

  {
    // 2. An empty selection is STILL exit 2. This is the flag's reason to
    //    exist: a dry run that matches nothing has found the bug it was run to
    //    look for, and reporting 0 there would be the silently-green pipeline
    //    wearing a different hat.
    const r = runCli(["run", "--tag", "nope", "--dry-run"], store);
    assert(r.code === EXIT.NO_MATCH, `a dry run that matches nothing is still exit ${EXIT.NO_MATCH}`);
  }

  {
    // 3. It reports the pace it WOULD go at, resolved rather than read. Every
    //    test recorded since R18 is unpinned, so printing the record's field
    //    would print nothing for all of them.
    const paced = makeStore([{ ...ONE_TEST[0], speed: undefined }]);
    try {
      const r = runCli(["run", "--tag", "smoke", "--dry-run", "--speed", "crawl"], paced);
      assert(
        r.stdout.includes("(crawl)"),
        "a dry run reports the resolved pace, including a --speed override",
      );
    } finally {
      rmSync(paced, { recursive: true, force: true });
    }
  }

  {
    // 4. It surfaces what a run would REFUSE to do. Finding out a suite skips
    //    half its tests for secrets should not require running it.
    const secret = makeStore([
      { ...ONE_TEST[0], variables: [{ name: "PASSWORD", kind: "secret" }] },
    ]);
    try {
      const r = runCli(["run", "--tag", "smoke", "--dry-run"], secret);
      assert(
        r.stdout.includes("SKIPPED") && r.stdout.includes("PASSWORD"),
        "a dry run names the tests a real run would skip, and why",
      );
    } finally {
      rmSync(secret, { recursive: true, force: true });
    }
  }

  {
    // 5. `--json` emits the plan itself rather than a re-shaped copy, so a
    //    pipeline reading it is reading what the runner planned.
    const r = runCli(["run", "--tag", "smoke", "--dry-run", "--json"], store);
    let parsed: { dryRun?: boolean; plan?: unknown[]; batchId?: string } = {};
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      // leave it empty; the assertions below report it
    }
    assert(parsed.dryRun === true, "--dry-run --json emits a plan marked as one");
    assert(Array.isArray(parsed.plan) && parsed.plan.length === 1, "…carrying the planned queue");
    assert(
      parsed.batchId === undefined,
      "…and no batchId, because nothing was recorded — a batch id would imply it was",
    );
  }

  // ── `install` refuses before downloading anything ──────────────────────
  //
  // Every case here is one where the alternative is a several-hundred-megabyte
  // download the caller did not ask for, so all of them have to fail at parse
  // time rather than after the network is busy.
  for (const [label, args] of [
    ["no browser named", ["install"]],
    ["an unknown engine", ["install", "safari"]],
    ["two browsers at once", ["install", "chromium", "firefox"]],
    ["an unknown flag", ["install", "chromium", "--force"]],
  ] as const) {
    const r = runCli([...args], store);
    assert(r.code === EXIT.CANNOT_START, `install exits ${EXIT.CANNOT_START} for ${label}`);
  }

  {
    const r = runCli(["install", "--help"], store);
    assert(r.code === EXIT.PASSED, "`install --help` exits 0");
    assert(
      r.stdout.includes("--with-deps"),
      "…and documents --with-deps, which a Linux CI image needs and macOS has no concept of",
    );
  }

  // ── An engine already there is a NO-OP, and says so ────────────────────
  //
  // The one that costs real money when it regresses. An install step runs on
  // every CI job, and re-downloading a browser that is already present is
  // minutes per job on every pipeline using this. Driven without a network by
  // planting the directories `isBrowserInstalled` looks for — which means this
  // also pins that the installer and the detector agree about what "installed"
  // means, since a mismatch here shows up as an attempted download.
  {
    const revisions = expectedRevisions("chromium");
    if (revisions.length === 0) {
      // Reported rather than skipped silently: a check that quietly covers
      // nothing is the shape this repo has been bitten by.
      assert(false, "could not read the bundled Playwright's chromium revision to plant it");
    } else {
      const planted = makeStore(ONE_TEST);
      try {
        for (const dir of revisions) mkdirSync(join(planted, "recorder", "browsers", dir));
        const r = runCli(["install", "chromium"], planted);
        assert(r.code === EXIT.PASSED, "installing an engine that is present exits 0");
        assert(
          r.stdout.includes("already installed"),
          r.stdout.includes("Installing")
            ? "…but it started a DOWNLOAD for a browser that is already there — minutes per CI job"
            : "…and says it is already installed rather than doing it again",
        );
      } finally {
        rmSync(planted, { recursive: true, force: true });
      }
    }
  }

  // ── A run with a browser present REACHES the runner ────────────────────
  //
  // THE GAP THIS FILE'S OWN HEADER NAMED, and the bug that lived in it. Every
  // other `run` case here has NO browser, so `runSelection` refuses before
  // `executeTest` is ever entered — which is why nothing noticed when the
  // fixture gates were declared BELOW the block that reads them. `const` is in
  // its temporal dead zone until the declaration executes, so from R8 until
  // 2026-08-26 every unattended run threw
  //
  //   ReferenceError: Cannot access 'anyCapability' before initialization
  //
  // before doing anything at all — the MCP's `run_test` included. 5800 unit
  // tests and 89 checks were green throughout, because none of them executes
  // that function.
  //
  // The browser directories are PLANTED, not downloaded, so this needs no
  // network: it gets past the gate, spawns Playwright, and fails to launch an
  // engine that is not really there. What is asserted is the SHAPE of that
  // failure — a browser problem, never a JavaScript one.
  {
    const revisions = expectedRevisions("chromium");
    if (revisions.length === 0) {
      assert(false, "could not read the bundled Playwright's chromium revision to plant it");
    } else {
      const planted = makeStore(ONE_TEST);
      try {
        for (const dir of revisions) mkdirSync(join(planted, "recorder", "browsers", dir));
        const r = runCli(["run", "--tag", "smoke"], planted);
        const all = `${r.stdout}\n${r.stderr}`;
        assert(
          !/ReferenceError|is not defined|before initialization/.test(all),
          `a run that gets past the gate fails on the BROWSER, not on JavaScript (got: ${
            /(?:ReferenceError|is not defined|before initialization)[^\n]*/.exec(all)?.[0] ?? "—"
          })`,
        );
        // And it did get past it: a refusal would never have spawned anything.
        assert(
          r.code === EXIT.FAILED || r.code === EXIT.CANNOT_START,
          `…and reports a run that could not complete (exit ${r.code})`,
        );
      } finally {
        rmSync(planted, { recursive: true, force: true });
      }
    }
  }

  // ── `run` now points at a command that exists ──────────────────────────
  //
  // The whole reason R11 shipped with the CLI rather than after it. The MCP's
  // answer to a missing browser is "run a test once from the app"; this binary's
  // audience is a CI runner, which has no app.
  {
    const r = runCli(["run", "--tag", "smoke"], store);
    assert(
      r.stderr.includes("good-looks install chromium"),
      "the missing-browser refusal names `good-looks install`, not the app",
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

  // ── `--junit` writes a real file, from a real run ──────────────────────
  //
  // R1's caller. The unit tests cover what the XML SAYS; this covers that the
  // flag reaches the writer at all through the real binary — the same gap
  // `check:mcp-boot` and this file's own existence are about, where every other
  // layer is green and the entry point is wired to nothing.
  //
  // Driven with the browser directories planted, so the run gets past the gate
  // and into `executeTest` without a network. The run itself FAILS — there is
  // no real browser behind those directories — which is the point: the report
  // has to be written for a failing run, since that is the run a CI operator
  // cares about.
  {
    const revisions = expectedRevisions("chromium");
    if (revisions.length === 0) {
      assert(false, "could not read the bundled Playwright's chromium revision to plant it");
    } else {
      const planted = makeStore(ONE_TEST);
      const report = join(planted, "results.xml");
      try {
        for (const dir of revisions) mkdirSync(join(planted, "recorder", "browsers", dir));
        const r = runCli(["run", "--tag", "smoke", "--junit", report], planted);
        let xml = "";
        try {
          xml = readFileSync(report, "utf8");
        } catch {
          // Left empty, and the assertion below names it.
        }
        assert(xml !== "", `--junit writes the report file (exit ${r.code}, stderr: ${r.stderr.trim().slice(0, 200)})`);
        assert(
          xml.includes("<testsuite") && xml.includes("</testsuite>"),
          "…as a complete testsuite element, not a truncated one",
        );
        assert(
          xml.includes('tests="1"'),
          "…covering exactly the run this invocation produced, and no other",
        );
        assert(
          r.stdout.includes("JUnit report:"),
          "…and says where it put it, so a CI step can be pointed at the path",
        );
      } finally {
        rmSync(planted, { recursive: true, force: true });
      }
    }
  }

  // ── …and never for a dry run ───────────────────────────────────────────
  //
  // A refusal rather than an empty file. Pinned here as well as in the parser's
  // unit test because it is a CONTRACT question: a pipeline told to read a
  // report must not be handed one describing nothing.
  {
    const store = makeStore(ONE_TEST);
    const report = join(store, "dry.xml");
    try {
      const r = runCli(["run", "--tag", "smoke", "--dry-run", "--junit", report], store);
      assert(r.code === EXIT.CANNOT_START, `--junit with --dry-run is a usage refusal (got ${r.code})`);
      let wrote = true;
      try {
        readFileSync(report, "utf8");
      } catch {
        wrote = false;
      }
      assert(!wrote, "…and writes no file at all, rather than an empty report");
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  }


  // ── A stale node_modules link beside the specs is REPAIRED ─────────────
  //
  // The behavioural half of parity section 16. That one reads source and would
  // pass against a repair that is written but never reached; this drives the
  // real binary and looks at the link afterwards.
  //
  // The link is absolute and points at whichever install wrote it, and it
  // outlives that install — which is exactly what a library copied to a CI
  // runner carries. Planted DANGLING here, the harder of the two cases:
  // `fs.existsSync` follows symlinks and answers false for it, so a
  // create-if-missing implementation calls `symlinkSync`, gets EEXIST because
  // the path is occupied, and leaves the broken link behind.
  //
  // Browser directories are planted so the run reaches `executeTest`, where the
  // repair lives. The run itself fails — there is no real browser behind them —
  // and that is fine: the link is repaired before the spawn.
  {
    const revisions = expectedRevisions("chromium");
    if (revisions.length === 0) {
      assert(false, "could not read the bundled Playwright's chromium revision to plant it");
    } else {
      const planted = makeStore(ONE_TEST);
      try {
        for (const dir of revisions) mkdirSync(join(planted, "recorder", "browsers", dir));
        const scripts = join(planted, "recorder", "scripts");
        mkdirSync(scripts, { recursive: true });
        const link = join(scripts, "node_modules");
        const stale = "/nonexistent/authoring-machine/node_modules";
        symlinkSync(stale, link, "dir");
        runCli(["run", "--tag", "smoke"], planted);
        let target = stale;
        try {
          target = readlinkSync(link);
        } catch {
          // Left as the stale value, and the assertion below names it.
        }
        assert(
          target !== stale,
          "a stale node_modules link beside the specs is repaired, not left in place " +
            "(a copied library otherwise dies at collection with a message about package.json)",
        );
        assert(
          target.endsWith(`${sep}node_modules`),
          `…and repointed at a node_modules directory (got ${target})`,
        );
      } finally {
        rmSync(planted, { recursive: true, force: true });
      }
    }
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

// ── What a CLI run RECORDS about itself (R6) ───────────────────────────────
//
// The one section here that performs a real run, and the reason is that nothing
// short of one can answer the question. `trigger` and `provenance` are written
// by `mcp/run-tests.mjs` — a module the CLI and the MCP server BOTH call — and
// what makes the value right is which caller is asking. A unit test would have
// to construct the runner itself, which is exactly the step that was wrong:
// until R6 the module wrote the literal `"mcp"`, so every `good-looks run`,
// every run of this repo's own GitHub Action included, was filed in the app's
// history as "Started by an MCP client". A source-level assertion cannot see
// that, because the source was self-consistent.
//
// No browser is needed. `isBrowserInstalled` reads a directory listing, so the
// expected `<engine>-<revision>` names are enough to get past the refusal, and
// Playwright then fails during COLLECTION on the missing spec — after the record
// is written and before anything launches.
{
  /** A library whose browsers directory LOOKS installed. Deliberately not a
   *  real install: this check runs on a machine that has never had one. */
  function storeThatCanRun(): string {
    const dir = makeStore(ONE_TEST);
    for (const name of expectedRevisions("chromium")) {
      mkdirSync(join(dir, "recorder", "browsers", name), { recursive: true });
    }
    return dir;
  }

  /** The single run this library recorded, or null. */
  function recordedRun(dataDir: string): {
    trigger?: string;
    provenance?: { revision?: string; branch?: string; repositoryUrl?: string; jobUrl?: string };
  } | null {
    try {
      const raw = readFileSync(join(dataDir, "recorder", "run-history.json"), "utf8");
      const all = JSON.parse(raw) as Array<Record<string, unknown>>;
      return (all[0] ?? null) as ReturnType<typeof recordedRun>;
    } catch {
      return null;
    }
  }

  /** A GitHub Actions environment. `GITHUB_HEAD_REF` is set and EMPTY on a push
   *  build — the real behaviour that makes `??` the wrong operator for choosing
   *  between it and `GITHUB_REF_NAME`. */
  const ACTIONS_ENV = {
    GITHUB_SHA: "9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3",
    GITHUB_REF_NAME: "main",
    GITHUB_HEAD_REF: "",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "csteubs/good-looks",
    GITHUB_RUN_ID: "32937507630",
  };

  // ── In CI ────────────────────────────────────────────────────────────────
  {
    const dir = storeThatCanRun();
    try {
      runCli(["run", "--id", "t-one"], dir, ACTIONS_ENV);
      const run = recordedRun(dir);
      assert(run !== null, "a CLI run writes a record the app will read back");
      assert(
        run?.trigger === "cli",
        run?.trigger === "mcp"
          ? "…attributed to the CLI — it says `mcp`, the literal R6 removed"
          : `…attributed to the CLI, not to whoever else calls the same runner (got ${JSON.stringify(run?.trigger)})`,
      );
      assert(
        run?.provenance?.revision === ACTIONS_ENV.GITHUB_SHA,
        "…and records the commit under test, which is the whole point on a runner",
      );
      assert(
        run?.provenance?.branch === "main",
        "…the branch from REF_NAME, since HEAD_REF is set-but-EMPTY on a push build",
      );
      assert(
        run?.provenance?.jobUrl ===
          `https://github.com/csteubs/good-looks/actions/runs/${ACTIONS_ENV.GITHUB_RUN_ID}`,
        "…and the job it ran in, so a red row can be opened rather than only counted",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── On a laptop ──────────────────────────────────────────────────────────
  {
    const dir = storeThatCanRun();
    try {
      runCli(["run", "--id", "t-one"], dir, {
        GITHUB_SHA: undefined,
        GITHUB_REF_NAME: undefined,
        GITHUB_HEAD_REF: undefined,
        GITHUB_SERVER_URL: undefined,
        GITHUB_REPOSITORY: undefined,
        GITHUB_RUN_ID: undefined,
        GITHUB_ACTIONS: undefined,
      });
      const run = recordedRun(dir);
      // ABSENT, not invented. The same command run at a desk has no commit to
      // report, and a fabricated one would be indistinguishable from a real
      // answer in every surface that reads it.
      assert(
        run?.provenance === undefined,
        "a run outside CI records NO provenance rather than a fabricated one",
      );
      // …while the trigger is still true, because it is a fact about the entry
      // point rather than about the environment. This is the whole reason the
      // value is `cli` and not `ci`.
      assert(
        run?.trigger === "cli",
        "…and is still attributed to the CLI, which is true wherever it ran",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── With a hostile branch name ───────────────────────────────────────────
  {
    const dir = storeThatCanRun();
    try {
      runCli(["run", "--id", "t-one"], dir, {
        ...ACTIONS_ENV,
        // A pull request from a fork names its own branch, so this is ordinary
        // untrusted input rather than a contrived one.
        GITHUB_HEAD_REF: `main${String.fromCharCode(10)}X-Injected: yes`,
      });
      const run = recordedRun(dir);
      assert(
        run?.provenance?.branch === undefined,
        "a branch name carrying a control character is not stored",
      );
      // The property that matters more than the refusal: the guard must not
      // cost the run the evidence it exists to protect.
      assert(
        run?.provenance?.revision === ACTIONS_ENV.GITHUB_SHA,
        "…and dropping it does NOT drop the commit, which is what a person needs",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}


if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll CLI exit-code checks passed.");
