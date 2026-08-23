// Which directories a run needs under the browsers path, for the Playwright
// the app ships — read from the CLI's own `browsers.json` rather than guessed
// from a name prefix.
//
// The prefix check this replaced (`chromium-*` exists ⇒ installed) was right
// until the first Playwright upgrade: 1.62 wanted `chromium-1234` and the
// directory held `chromium-1178` from 1.53, so every run on the upgraded app
// launched against a browser that was not there and died with "Executable
// doesn't exist … npx playwright install".
//
// Shared because BOTH PROCESSES ask the question — the app's runner and the
// MCP server each decide whether to install before a run — and the prefix
// rule had already been copied into both. One rule, pure (no fs: the caller
// hands in the file's text and the directory listing), so the MCP, which has
// no build step, imports the same .mjs the app does.
/** The directory names the CLI unpacks an engine into, for this
 *  `browsers.json`. Chromium is two: the full browser and the headless shell
 *  a headless run launches. Null when the file does not name the engine —
 *  the caller then falls back to the prefix rule rather than refusing to run
 *  at all. */
export function expectedBrowserDirs(browsersJson, browser) {
  let parsed;
  try {
    parsed = JSON.parse(browsersJson);
  } catch {
    return null;
  }
  const revisions = new Map();
  for (const b of Array.isArray(parsed?.browsers) ? parsed.browsers : []) {
    if (typeof b?.name === "string" && typeof b?.revision === "string") revisions.set(b.name, b.revision);
  }
  const names = browser === "chromium" ? ["chromium", "chromium-headless-shell"] : [browser];
  const dirs = [];
  for (const name of names) {
    const rev = revisions.get(name);
    if (!rev) return null;
    // Directory names spell the engine with underscores: chromium_headless_shell-1234.
    dirs.push(`${name.replace(/-/g, "_")}-${rev}`);
  }
  return dirs;
}

/** Whether every directory a run needs is present. The fallback — no
 *  `browsers.json` to read — is the old prefix rule, which at least refuses
 *  a headless-shell-only install for a headed run. */
export function browserInstalledIn(entries, browser, expected) {
  if (expected) return expected.every((d) => entries.includes(d));
  return entries.some((n) => n.startsWith(`${browser}-`));
}
