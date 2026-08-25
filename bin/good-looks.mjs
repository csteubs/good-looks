#!/usr/bin/env node
//
// The `good-looks` command (R3).
//
// Deliberately thin: argv in, exit code out. Everything with a rule in it lives
// in `cli/`, where it can be driven by a test — this file is the one part that
// cannot be, because its whole job is to touch `process`.
//
// ── Why the exit code is set rather than thrown ──────────────────────────
// `process.exitCode` and a natural return, not `process.exit(n)`. `process.exit`
// terminates before pending stdout writes flush, and stdout to a PIPE — which
// is what a CI runner gives you — is asynchronous. A CLI that exits immediately
// after `console.log` prints nothing at all when its output is piped, reliably,
// and works perfectly when you test it in a terminal.

import process from "node:process";

import { parseRunArgs, RUN_USAGE } from "../cli/args.mjs";
import { EXIT, EXIT_MEANINGS } from "../cli/exit.mjs";
import { runCommand } from "../cli/run.mjs";
import { resolveDataDir } from "../mcp/data-dir.mjs";

const USAGE = `good-looks — run recorded Playwright tests from the command line.

Usage: good-looks <command> [options]

Commands:
  run        run recorded tests and exit on their result
  data-dir   print the library directory this CLI reads
  help       show this

Exit codes:
${EXIT_MEANINGS.map(([code, meaning]) => `  ${code}  ${meaning}`).join("\n")}

Run \`good-looks run --help\` for the run options.
`;

const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);

async function main(argv) {
  const [command, ...rest] = argv;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    // To stdout, not stderr, and exit 0: an explicit `--help` is a request that
    // succeeded. Only an unknown command puts usage on stderr.
    out(USAGE);
    return EXIT.PASSED;
  }

  if (command === "--version" || command === "-v") {
    // Read at runtime rather than baked in, so a packaged copy reports its own
    // version rather than the one the file was written beside.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    out(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
    return EXIT.PASSED;
  }

  if (command === "data-dir") {
    // Its own command because "which library am I about to run?" is the first
    // question of every CI failure that turns out to be a misconfigured runner,
    // and answering it should not require running a test.
    try {
      out(resolveDataDir());
      return EXIT.PASSED;
    } catch (error) {
      err(String(error.message ?? error));
      return EXIT.CANNOT_START;
    }
  }

  if (command === "run") {
    const parsed = parseRunArgs(rest);
    if (parsed.ok === "help") {
      out(RUN_USAGE);
      return EXIT.PASSED;
    }
    if (!parsed.ok) {
      err(parsed.error);
      err("");
      err(RUN_USAGE);
      // 3, not a usage-specific code: the contract has four numbers and this is
      // "the run could not start". A pipeline reading 3 has one thing to do —
      // look at how it invoked the CLI or at what it installed — and both are
      // the same kind of fix.
      return EXIT.CANNOT_START;
    }
    return runCommand(parsed.options, { out, err });
  }

  err(`Unknown command "${command}".`);
  err("");
  err(USAGE);
  return EXIT.CANNOT_START;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    // The last resort. A CLI that dies with an unhandled rejection prints a
    // stack trace and exits 1, which a pipeline reads as "a test failed" — the
    // single most misleading answer available. Nothing ran; say so.
    err(String(error?.stack ?? error));
    process.exitCode = EXIT.CANNOT_START;
  });
