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

import { RUN_BROWSERS } from "../mcp/run-tests.mjs";
import { SLOW_MO_MS } from "../shared/run-pacing.mjs";
import { MAX_PARALLEL } from "../mcp/run-pool.mjs";

/** Speeds the `--speed` flag accepts, read off the delay table rather than
 *  listed again — a fifth speed added there is accepted here the same day. */
const SPEEDS = Object.keys(SLOW_MO_MS);

/** Flags that take a value. Anything else beginning with `-` is a boolean, and
 *  anything not in either set is an error. */
const VALUE_FLAGS = new Set(["--id", "--tag", "--group", "--browser", "--speed", "--parallel"]);
const BOOL_FLAGS = new Set(["--all", "--json", "--all-datasets", "--help", "-h"]);

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
  let json = false;
  let allDatasets = false;

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

  return {
    ok: true,
    options: {
      testIds: ids.length > 0 ? ids : undefined,
      tag,
      group,
      browser,
      speed,
      parallel,
      allDatasets: allDatasets || undefined,
      json,
    },
  };
}

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
  --all-datasets     run each selected test once per dataset row it declares
  --json             print the machine-readable result instead of a summary
  -h, --help         show this
`;
