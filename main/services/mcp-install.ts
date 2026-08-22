// Where this install's MCP server is, and the command that registers it.
//
// The Documentation pane shows a copyable `claude mcp add …` line. A path in
// documentation is a path someone types wrong; a path this process resolved is
// one that is either right or knowably absent. So this answers from DISK.
//
// A PACKAGED APP NOW CARRIES THE SERVER (R15, 2026-08-22). `build.files` ships
// `mcp/**` and `shared/**` into `Contents/Resources/app`, which is exactly what
// `PROJECT_ROOT` below resolves to — so `exists` became true in a `.app` with no
// change to the resolution here, and the pane's copy-command branch, written
// long before it could ever fire, started firing. The absent branch is kept for
// a dev tree run from a stripped checkout, and because a `files` regression
// should degrade to an honest message rather than a command naming nothing.
//
// TWO THINGS THE PACKAGED PATH CHANGES, both invisible until you paste it:
//
//   1. The path has no `node` beside it. Someone who installed the app rather
//      than cloning the repo very likely has no Node at all, so the command
//      names the app's OWN Electron binary and sets ELECTRON_RUN_AS_NODE — the
//      same trick `playwright-runner` uses to spawn the Playwright CLI.
//   2. The product is called "Good Looks!", so the path contains a `!`, and a
//      `!` inside DOUBLE quotes is a history expansion in every interactive
//      zsh and bash. The old command was double-quoted and worked only because
//      the path it named was a repo checkout. Pasted with a bundle path it
//      fails with `event not found` before running anything.
//
// No direct `electron` import — `app` comes through `@shell/backend`, the same
// seam the logger does.

import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { app, logger } from "@shell/backend";

/** The backend is bundled to `build/main/index.js`, so the project root is two
 *  levels above this file's directory at runtime. */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface McpServerInfo {
  /** Absolute path to `mcp/server.mjs`, whether or not it is there. Null only
   *  if the root could not be resolved at all. */
  path: string | null;
  exists: boolean;
  /** Empty when there is nothing to register. A command that cannot work is
   *  not a command worth offering to copy. */
  command: string;
}

/**
 * Wrap a path for a shell the user will PASTE into.
 *
 * SINGLE quotes, not double. Every real path here needs quoting for its spaces
 * ("Application Support", "Good Looks!.app"), but double quotes leave `!` live
 * to history expansion in interactive zsh and bash — and this app's own name
 * ends in one, so a double-quoted bundle path fails with `event not found`
 * before the command runs. Inside single quotes nothing is special, and an
 * embedded single quote is closed, escaped and reopened in the usual way.
 */
function shellQuote(value: string): string {
  // `split`/`join` rather than `replaceAll`: this project targets ES2020.
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * The command that registers this install with Claude Code.
 *
 * A packaged app names its OWN binary with `ELECTRON_RUN_AS_NODE=1` rather than
 * `node`: the whole point of shipping the server is that someone who installed
 * the `.app` can use it, and that person has no reason to have Node. Under
 * Electron `process.execPath` IS that binary. From a checkout, `node` is right
 * and is what a developer already has.
 */
function registerCommand(serverPath: string): string {
  const base = "claude mcp add --scope user good-looks";
  if (app.isPackaged) {
    return `${base} -e ELECTRON_RUN_AS_NODE=1 -- ${shellQuote(process.execPath)} ${shellQuote(serverPath)}`;
  }
  return `${base} -- node ${shellQuote(serverPath)}`;
}

export function mcpServerInfo(): McpServerInfo {
  const serverPath = path.join(PROJECT_ROOT, "mcp", "server.mjs");
  let exists = false;
  try {
    exists = existsSync(serverPath);
  } catch (err) {
    // A stat that throws is "cannot say", which is the same answer as absent
    // for the pane's purposes. Never let it reach the window.
    logger.warn("docs", "Could not check for the MCP server", { err: String(err) });
  }
  return { path: serverPath, exists, command: exists ? registerCommand(serverPath) : "" };
}
