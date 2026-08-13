// Where this install's MCP server is, and the command that registers it.
//
// The Documentation pane shows a copyable `claude mcp add …` line. A path in
// documentation is a path someone types wrong; a path this process resolved is
// one that is either right or knowably absent. So this answers from DISK.
//
// THE ABSENT CASE IS THE COMMON ONE IN A PACKAGED APP, and that is not a bug
// here. `mcp/` is part of the source tree, and electron-builder's `files` ships
// `build/**` and `package.json` — so a `.app` has no server to point at. The
// pane says so rather than printing a plausible command that names nothing.
// Making the packaged app host the server is a separate decision (it also needs
// the server's data-directory resolution revisited, which derives a Glaze-era
// path); see docs/DECISIONS.md.
//
// No `electron` import: the build root is derived the same way `window-paths`
// derives it, from this module's own location.

import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "@shell/backend";

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

/** Quoted because the path contains spaces on every real install — the data
 *  directory is under "Application Support". */
function registerCommand(serverPath: string): string {
  return `claude mcp add --scope user good-looks -- node "${serverPath}"`;
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
