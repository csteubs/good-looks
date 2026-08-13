// The app looks like itself: its own icon, its own name in the menu bar, and
// no title bar text.
//
// WHY A CHECK. All three live in places nothing else tests. The Dock icon and
// the menu bar title come from a macOS BUNDLE, which exists only for a packaged
// build — in dev, `electron .` runs `node_modules/electron/dist/Electron.app`
// and macOS reads that, so the app shows the Electron atom and an "Electron"
// menu however carefully the code sets its name. The fix is a branded clone of
// Electron.app built by scripts/dev-app-bundle.mjs, and the failure mode when
// it rots is exactly the one it was written to remove: the app still runs, and
// just looks like somebody else's.
//
// So the plist half runs the REAL script and reads what it produced, in the
// spirit of check:branch-switch — a source scan would have happily passed the
// version of this that set CFBundleName and left CFBundleExecutable alone,
// which still says "Electron" (macOS falls back to the executable's name).
//
// The title half is source-level, like check:scroll-layout: an untitled window
// needs BOTH ends (an empty <title> and a main process that refuses
// page-title-updated), jsdom has no window title, and either end alone reads as
// working until some page sets document.title.
//
// Run with: npm run check:app-identity

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { ensureDevAppExecutable, DEV_APP_NAME } from "../../../scripts/dev-app-bundle.mjs";

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

// ── The window carries no title ───────────────────────────────────────

{
  const mainSrc = readFileSync(join(root, "main/index.ts"), "utf-8");

  assert(
    /const windowTitle = "";/.test(mainSrc),
    "the main window is created with an empty title",
  );

  // The one that is easy to lose in a refactor: without it, the first
  // `document.title = …` anywhere in the renderer puts the title bar back.
  assert(
    /page-title-updated["']?\s*,\s*\(?\s*event\s*\)?\s*=>\s*event\.preventDefault\(\)/.test(mainSrc),
    "the main window refuses page titles, so no page can retitle it",
  );

  const html = readFileSync(join(root, "main-window.html"), "utf-8");
  const title = /<title>([\s\S]*?)<\/title>/.exec(html);
  assert(title !== null && title[1].trim() === "", "main-window.html carries an empty <title>");

  const entry = readFileSync(join(root, "renderer/main/index.tsx"), "utf-8");
  assert(
    !/^\s*document\.title\s*=/m.test(entry),
    "the main renderer entry does not set document.title",
  );
}

// ── The dev bundle wears the app's name and icon ──────────────────────

{
  const dev = readFileSync(join(root, "scripts/dev.mjs"), "utf-8");
  assert(
    /ensureDevAppExecutable/.test(dev),
    "`npm run dev` asks for the branded bundle rather than launching Electron directly",
  );
  assert(
    /npx["']?,\s*\["']electron/.test(dev) || /"npx",\s*\["electron"/.test(dev),
    "`npm run dev` still falls back to plain Electron, so a bundle it cannot build never blocks a launch",
  );
}

if (process.platform !== "darwin") {
  console.log("skip the bundle itself — macOS-only (Info.plist, codesign)");
} else if (!existsSync(join(root, "node_modules/electron/dist/Electron.app"))) {
  // Not a pass: this check cannot say anything without the Electron it clones.
  failures++;
  console.error("FAIL no node_modules/electron/dist/Electron.app to brand — run npm install");
} else {
  const executable = ensureDevAppExecutable({ repoRoot: root, force: true, log: () => {} });
  assert(executable !== null, "the branded dev bundle builds");

  if (executable) {
    assert(
      executable.endsWith(`/${DEV_APP_NAME}`),
      `the executable is renamed to "${DEV_APP_NAME}" — macOS uses CFBundleExecutable for the process name, so a bundle that keeps "Electron" still says Electron`,
    );

    const appPath = join(executable, "..", "..", "..");
    const plist = join(appPath, "Contents", "Info.plist");
    const read = (key: string) =>
      execFileSync("plutil", ["-extract", key, "raw", "-o", "-", plist], {
        encoding: "utf-8",
      }).trim();

    assert(read("CFBundleName") === DEV_APP_NAME, `CFBundleName is "${DEV_APP_NAME}"`);
    assert(read("CFBundleDisplayName") === DEV_APP_NAME, `CFBundleDisplayName is "${DEV_APP_NAME}"`);
    assert(read("CFBundleExecutable") === DEV_APP_NAME, `CFBundleExecutable is "${DEV_APP_NAME}"`);
    assert(
      read("CFBundleIdentifier") !== "com.github.Electron",
      "the dev bundle has its own identifier, so macOS never conflates it with a packaged install",
    );

    // The icon macOS actually draws is the file CFBundleIconFile names, and it
    // has to be OUR icns — an icon copied to any other name is invisible.
    const iconFile = read("CFBundleIconFile").replace(/\.icns$/, "") + ".icns";
    const bundled = readFileSync(join(appPath, "Contents", "Resources", iconFile));
    const source = readFileSync(join(root, "build-icon.icns"));
    assert(bundled.equals(source), "the bundle's icon is the app's own build-icon.icns");

    // Editing Info.plist invalidates the ad-hoc signature Electron ships with,
    // and on Apple Silicon the kernel kills a binary whose signature does not
    // match — a bundle that fails this does not launch at all.
    //
    // Deliberately NOT `--deep`: stock Electron.app fails that on its own
    // ("code has no resources but signature indicates they must be present",
    // from Electron Framework.framework), so a --deep gate here would report
    // Electron's shipping bundle as broken and teach everyone to ignore it.
    let signed = true;
    try {
      execFileSync("codesign", ["--verify", appPath], { stdio: "pipe" });
    } catch {
      signed = false;
    }
    assert(signed, "the edited bundle is re-signed, so macOS will run it");
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll app-identity checks passed.");
