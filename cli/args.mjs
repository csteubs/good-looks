// Parsing `good-looks run …` — pure, so the argument rules can be argued with
// in a unit test rather than by running a suite.
//
// No dependency on a parsing library, and not because one would be wrong: the
// rules that matter here are the ones a generic parser has no opinion about.
// Which selectors may be combined, what an absent selector means, whether an
// unknown flag is a warning or a refusal — those are this CLI's decisions, and
// each of them is a way to run the wrong tests silently.
//
// ── The rule this file exists for ─────────────────────────────────────────
// AN UNKNOWN FLAG IS A REFUSAL, not a warning. A CI pipeline that passes
// `--fail-fast` to a build of the CLI that does not have it yet must not run
// the suite anyway and report green: the operator asked for behaviour they did
// not get. The same goes for a flag that needs a value and was given none —
// `--tag --json` must not silently select the tag "--json".

import { normalizeBaseUrl } from "../shared/base-url.mjs";
import { RUN_BROWSERS } from "../mcp/run-tests.mjs";
import { SLOW_MO_MS } from "../shared/run-pacing.mjs";
import { MAX_PARALLEL } from "../mcp/run-pool.mjs";
import { MAX_RETRIES } from "../shared/run-attempts.mjs";

/** Speeds the `--speed` flag accepts, read off the delay table rather than
 *  listed again — a fifth speed added there is accepted here the same day. */
const SPEEDS = Object.keys(SLOW_MO_MS);

/** Flags that take a value. Anything else beginning with `-` is a boolean, and
 *  anything not in either set is an error. */
const VALUE_FLAGS = new Set([
  "--id",
  "--tag",
  "--group",
  "--browser",
  "--speed",
  "--parallel",
  "--retries",
  "--secrets-file",
  "--junit",
  "--base-url",
  "--var",
]);
const BOOL_FLAGS = new Set(["--all", "--json", "--all-datasets", "--dry-run", "--help", "-h"]);

/** The selectors, in the precedence `selectTests` resolves them. Named here so
 *  the error message about combining them lists them in that order too. */
const SELECTORS = ["--id", "--group", "--tag", "--all"];

function fail(error) {
  return { ok: false, error };
}

/**
 * Parse the argument list of `good-looks run`.
 *
 * @param {string[]} argv arguments AFTER the subcommand
 * @returns {{ok: true, options: object} | {ok: false, error: string} | {ok: "help"}}
 */
export function parseRunArgs(argv) {
  // Scanned FIRST, before anything can be rejected. `--fail-fast --help` is
  // someone asking what the flags are because the one they tried was not
  // recognised, and answering "unknown option" without the list is the least
  // useful thing available at that moment.
  //
  // It exits 0, which is the one place this CLI reports success for a run that
  // did not happen — and the exception is deliberate: the contract is about
  // RUNS, and `--help` is not one. A pipeline with `--help` in it is broken in
  // a way no exit code repairs.
  if (argv.includes("--help") || argv.includes("-h")) return { ok: "help" };

  /** @type {string[]} */
  const ids = [];
  let tag;
  let group;
  let all = false;
  let browser;
  let speed;
  let parallel;
  let retries;
  let json = false;
  let allDatasets = false;
  let dryRun = false;
  let secretsFile;
  let junit;
  let baseUrl;
  /** @type {Record<string,string>} */
  const vars = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      // A missing value, or the next flag standing in for one. Both are the
      // same mistake and both would otherwise select something nobody asked
      // for: `--tag --json` would run the tag named "--json", match nothing,
      // and — before exit code 2 existed — report a clean pass.
      if (value === undefined || value.startsWith("-")) {
        return fail(`${arg} needs a value.`);
      }
      i++;
      switch (arg) {
        case "--id":
          // Repeatable, and each one is kept: `selectTests` runs explicit ids in
          // the order given, so the order they are typed in is meaningful.
          ids.push(value);
          break;
        case "--tag":
          tag = value;
          break;
        case "--group":
          group = value;
          break;
        case "--junit":
          // The PATH only, for the same reason `--secrets-file` is: the parser
          // stays pure and testable, and nothing here touches the filesystem.
          // Not validated as absolute — unlike the app's `emitReportTo`, a
          // CLI's cwd is the shell the operator typed in, and `--junit
          // results.xml` in a workspace is the normal spelling.
          junit = value;
          break;
        case "--base-url": {
          // Refused rather than ignored, like `--speed` and `--browser`. It
          // goes through the SAME `normalizeBaseUrl` every other way in uses —
          // the imported project's config and the app's own field — so the CLI
          // cannot accept a URL the app would refuse. A `file://` here would
          // point a run at the local disk.
          //
          // The NORMALIZED value is kept, not the typed one: `HTTPS://Shop.EXAMPLE.com`
          // and `https://shop.example.com/` are one base URL and must not be
          // recorded on two runs as two.
          const normalized = normalizeBaseUrl(value);
          if (!normalized) {
            return fail(
              `--base-url must be an http(s) URL, got "${value}".`,
            );
          }
          baseUrl = normalized;
          break;
        }
        case "--var": {
          // `name=value`, repeatable. Split on the FIRST `=` only: a value may
          // legitimately contain one (a URL with a query string is the obvious
          // case), and splitting on every `=` would truncate it silently.
          const eq = value.indexOf("=");
          if (eq < 1) {
            return fail(`--var needs name=value, got "${value}".`);
          }
          const name = value.slice(0, eq);
          // The generator substitutes DECLARED names only, so an undeclared one
          // is not dangerous — but it is almost always a typo, and a run that
          // silently ignores it is a run against the wrong environment. The
          // parser cannot know what a test declares; `runSelection` reports it.
          vars[name] = value.slice(eq + 1);
          break;
        }
        case "--secrets-file":
          // The PATH only. Nothing here reads it — a parser that touched the
          // filesystem could not be unit-tested, and a credential file is the
          // last thing to read somewhere incidental.
          secretsFile = value;
          break;
        case "--browser":
          if (!RUN_BROWSERS.includes(value)) {
            return fail(`Unknown browser "${value}". Choose one of: ${RUN_BROWSERS.join(", ")}.`);
          }
          browser = value;
          break;
        case "--speed":
          // Refused rather than ignored. An unrecognised speed is skipped by
          // `resolveRunSpeed` — correct there, because a hostile or stale value
          // must not reach the delay table — but here it would mean the run
          // silently went at a pace nobody chose after someone explicitly
          // asked. The layer that has a user to talk to is the one that says so.
          if (!SPEEDS.includes(value)) {
            return fail(`Unknown speed "${value}". Choose one of: ${SPEEDS.join(", ")}.`);
          }
          speed = value;
          break;
        case "--retries": {
          // Whole numbers only, same rule as --parallel and for the same
          // reason. A misspelt value must not silently become "no retries" —
          // the whole point of asking is that the caller expects the suite to
          // absorb an intermittent, and a run that quietly did not is a report
          // they will read as a real failure.
          if (!/^\d+$/.test(value)) {
            return fail(`--retries needs a whole number, got "${value}".`);
          }
          const n = Number(value);
          if (n > MAX_RETRIES) {
            return fail(`--retries must be ${MAX_RETRIES} or fewer, got ${n}.`);
          }
          retries = n;
          break;
        }
        case "--parallel": {
          // Whole numbers only. `--parallel 2.5` and `--parallel eight` are
          // both someone expecting something; neither should quietly become 1.
          if (!/^\d+$/.test(value)) {
            return fail(`--parallel needs a whole number, got "${value}".`);
          }
          const n = Number(value);
          if (n < 1 || n > MAX_PARALLEL) {
            return fail(`--parallel must be between 1 and ${MAX_PARALLEL}, got ${n}.`);
          }
          parallel = n;
          break;
        }
      }
      continue;
    }

    if (BOOL_FLAGS.has(arg)) {
      if (arg === "--all") all = true;
      if (arg === "--json") json = true;
      if (arg === "--all-datasets") allDatasets = true;
      if (arg === "--dry-run") dryRun = true;
      continue;
    }

    // Everything else. A positional argument is as much a mistake as an unknown
    // flag — `good-looks run smoke` looks like it selects a tag and does not.
    return arg.startsWith("-")
      ? fail(`Unknown option "${arg}".`)
      : fail(`Unexpected argument "${arg}". Tests are selected with --id, --tag, --group or --all.`);
  }

  const given = SELECTORS.filter(
    (s) =>
      (s === "--id" && ids.length > 0) ||
      (s === "--group" && group !== undefined) ||
      (s === "--tag" && tag !== undefined) ||
      (s === "--all" && all),
  );

  // NO DEFAULT SELECTOR. The MCP's `run_batch` runs everything visible when it
  // is given no selector, which is right for a tool an agent calls with an
  // explicit intent behind it. For a CLI it is the wrong default in the one
  // direction that costs: a typo'd flag name that made it here would run the
  // entire library on someone's CI runner instead of the four tests they meant.
  if (given.length === 0) {
    return fail("Nothing selected. Pass --id, --tag, --group, or --all to run everything.");
  }
  // Refused rather than resolved by precedence. `selectTests` HAS a precedence
  // (ids > group > tag), so this would run something — just not necessarily
  // what the person who wrote both flags expected, and they would never find
  // out. Two selectors is a question, and the answer belongs to the caller.
  if (given.length > 1) {
    return fail(`Use one selector at a time — got ${given.join(" and ")}.`);
  }
  // Refused rather than ignored. A dry run produces no runs, so there is
  // nothing for the report to describe — and writing an empty one, or quietly
  // writing none, both end with a pipeline configured to read a file that
  // never says anything. The flag combination is the question; the answer
  // belongs to whoever typed it.
  if (dryRun && junit !== undefined) {
    return fail("--junit reports runs, and --dry-run performs none. Use one or the other.");
  }

  return {
    ok: true,
    options: {
      testIds: ids.length > 0 ? ids : undefined,
      tag,
      group,
      browser,
      speed,
      parallel,
      retries,
      allDatasets: allDatasets || undefined,
      dryRun,
      secretsFile,
      junit,
      baseUrl,
      vars: Object.keys(vars).length > 0 ? vars : undefined,
      json,
    },
  };
}

/**
 * Parse `good-looks install <browser> [--with-deps]`.
 *
 * The browser is POSITIONAL here where `run` takes it as a flag, and that is
 * not an inconsistency: `run` has a default engine (chromium) and `install` has
 * no sensible default at all. Installing "whatever you assumed I meant" is a
 * several-hundred-megabyte download nobody asked for.
 *
 * @param {string[]} argv arguments AFTER the subcommand
 * @returns {{ok: true, options: {browser: string, withDeps: boolean}} | {ok: false, error: string} | {ok: "help"}}
 */
export function parseInstallArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { ok: "help" };

  let browser;
  let withDeps = false;
  for (const arg of argv) {
    if (arg === "--with-deps") {
      withDeps = true;
      continue;
    }
    if (arg.startsWith("-")) return fail(`Unknown option "${arg}".`);
    // A second positional is a mistake worth naming rather than ignoring:
    // `install chromium firefox` reads as installing both and would install one.
    if (browser !== undefined) {
      return fail(`Install one browser at a time — got "${browser}" and "${arg}".`);
    }
    if (!RUN_BROWSERS.includes(arg)) {
      return fail(`Unknown browser "${arg}". Choose one of: ${RUN_BROWSERS.join(", ")}.`);
    }
    browser = arg;
  }
  if (browser === undefined) {
    return fail(`Which browser? Choose one of: ${RUN_BROWSERS.join(", ")}.`);
  }
  return { ok: true, options: { browser, withDeps } };
}

export const INSTALL_USAGE = `Usage: good-looks install <${RUN_BROWSERS.join("|")}> [--with-deps]

Download a browser engine into this library's own browsers directory.

Playwright's ordinary install puts engines in a machine-wide cache; runs here
look under the app's data directory, so \`npx playwright install\` leaves a
browser no run can find. This installs the bundled Playwright's revision into
the place runs actually launch from, and is a no-op when the engine is there.

Options:
  --with-deps    also install the system libraries the engine needs (Linux CI
                 images; needs root, and is not a concept on macOS)
  -h, --help     show this
`;

/** Everything `--help` prints for `run`. A template literal rather than a
 *  generated table: the flags are few, and a reader wants them in a sensible
 *  order rather than in declaration order. */
export const RUN_USAGE = `Usage: good-looks run (--id <id> | --tag <tag> | --group <folder> | --all) [options]

Run recorded tests headlessly and exit on their result.

Selection (exactly one, and there is no default — a CLI that runs the whole
library when a flag is misspelt is worse than one that refuses):
  --id <id>          run this test; repeat the flag to run several, in order
  --tag <tag>        run every visible test carrying this tag
  --group <folder>   run every visible test in this library folder
  --all              run every visible test

Options:
  --browser <name>   ${RUN_BROWSERS.join(" | ")} (default: chromium)
  --speed <name>     ${SPEEDS.join(" | ")} — overrides the test's own pace for
                     this run only, and is never written back to the test
  --parallel <n>     run n tests at once, 1-${MAX_PARALLEL} (default: 1)
  --retries <n>      re-run a failed test up to n times, 0-${MAX_RETRIES} (default: 0)
                     A run that passes on a retry is recorded as passed AND
                     counted as a failure by the flake analysis.
  --all-datasets     run each selected test once per dataset row it declares
  --secrets-file <f> JSON object of secret values for tests that declare them,
                     keyed "<testId>.<name>" or "<name>". An environment
                     variable of the same meaning wins over it — run without
                     this and the CLI names the variables to set
  --junit <path>     also write a JUnit XML report of THIS invocation's runs.
                     Scoped to them and nothing else: a wider report could
                     include a run this process has no secret values for, and
                     could not redact
  --dry-run          print what WOULD run and stop. Same selection and the same
                     queue expansion as a real run, so the answer is the plan
                     rather than a description of it. Still exits 2 when the
                     selector matches nothing, which is what it is for
  --json             print the machine-readable result instead of a summary
  -h, --help         show this
`;
