// @ts-check

// Project ESLint config. It exists only to extend the Glaze SDK's shared config
// with one extra global ignore: the git worktrees this repo keeps under
// `.claude/worktrees/<branch>/` (see CLAUDE.md "Making a change"). Those are full
// checkouts of other branches; linting them lints a second copy of the whole app
// under the wrong TS/globals config, producing thousands of bogus `no-undef`
// errors that have nothing to do with the working tree.
//
// The SDK CLI only auto-discovers this file when it is named `eslint.config.js`
// at the app root; when present it is used INSTEAD of the SDK config, so we import
// the SDK config and re-export it with our ignore appended rather than replacing
// its ruleset.
//
// The SDK is located with the same relative/ancestor search `glaze.ts` uses, so
// this stays free of machine-specific absolute paths (repo hygiene forbids them)
// and keeps working from a worktree checkout.

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function ancestors(from) {
  const out = [];
  let dir = from;
  for (;;) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
}

const candidates = [
  resolve(__dirname, "../glaze-core/cli/lint/eslint.config.js"),
  resolve(__dirname, "../../../sdk/current/@glaze/core/cli/lint/eslint.config.js"),
  ...ancestors(__dirname).map((dir) =>
    resolve(dir, "sdk/current/@glaze/core/cli/lint/eslint.config.js"),
  ),
];

const sdkConfigPath = candidates.find(existsSync);
if (!sdkConfigPath) {
  throw new Error(
    "[glaze] Could not locate the SDK ESLint config. Searched:\n" +
      candidates.map((p) => `  - ${p}`).join("\n"),
  );
}

const sdkModule = await import(pathToFileURL(sdkConfigPath).href);
const sdkConfig = sdkModule.default ?? sdkModule;

export default [
  // Global ignore (a config object with only `ignores` applies repo-wide).
  //
  // `build-preview/` is `npm run build:preview`'s output. The SDK's shared
  // config already ignores `build/` and `dist/`, but not this one — and a
  // minified bundle lints as ~800 `no-undef` errors on browser globals, which
  // buries any real finding under a wall of noise from generated code.
  { ignores: [".claude/**", "build-preview/**"] },
  ...(Array.isArray(sdkConfig) ? sdkConfig : [sdkConfig]),
];
