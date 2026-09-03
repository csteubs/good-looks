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
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

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

/** `assert` for a scan: the label stays a clean sentence when it passes, and
 *  names every offending site when it does not — a guard whose success message
 *  ends in "found: " reads as broken output the first time somebody sees it. */
function assertNone(hits: string[], label: string): void {
  assert(hits.length === 0, hits.length === 0 ? label : `${label} — found: ${hits.join(", ")}`);
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

// ── The app answers with its OWN name and version, never a literal ────
//
// WHY THIS IS HERE. The Glaze template shipped an `app:getInfo` IPC handler
// whose entire body was three hard-coded literals — `name: "My Glaze App"`,
// `version: "1.0.0"`, and `environment` off `NODE_ENV`, which nothing sets in
// a packaged Electron build. Nothing ever called it, so it survived the SDK
// port intact and was still answering with a different app's name and a
// version two minors behind on the day it was deleted. That is the failure
// this check already exists for, one layer in from the Dock icon: the app runs
// perfectly and just says it is somebody else.
//
// It is a SOURCE scan rather than a runtime one because there is nothing to
// run. The preload exposes a generic `glaze.ipc.invoke(channel, …)`
// (renderer/preload.ts) instead of a per-channel surface, so a re-added
// handler has no declaration anywhere to contradict and no caller to fail —
// exactly the shape that let the first one live. The runtime half is
// `main/handlers/handlers.test.ts`, which asserts the channel is not
// registered; neither half subsumes the other, since a scaffold could be
// written back as a service the handler calls.
//
// "The reported version equals package.json's" is asserted as its
// contrapositive: the app must never STATE a version, only read one.
// `app.getVersion()` is package.json's `version` by Electron's own contract,
// so a code path that goes through it cannot disagree; a literal is the only
// way to be wrong, and `version: "1.0.0"` was that literal. The changelog is
// the one legitimate place a version string is written down, and its agreement
// with package.json is pinned separately by `release-notes.test.ts`.

{
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
    version?: string;
    productName?: string;
    build?: { productName?: string };
  };

  // The name this check pins everywhere above is only worth pinning if it is
  // still the app's own. `DEV_APP_NAME`'s docblock says it must match
  // `build.productName`; nothing enforced it, so renaming the app in
  // package.json would have left every assertion above happily pinning the old
  // name — a green check certifying the wrong identity.
  assert(
    pkg.productName === DEV_APP_NAME,
    `package.json productName is "${DEV_APP_NAME}", the name the dev bundle is branded with`,
  );
  assert(
    pkg.build?.productName === DEV_APP_NAME,
    `build.productName is "${DEV_APP_NAME}", so a packaged build and a dev run agree`,
  );

  const ROOTS = ["main", "renderer", "shared", "mcp", "cli", "bin", "scripts", "e2e", "workers"];
  const SOURCE = /\.(ts|tsx|mts|mjs|js|jsx)$/;

  function sources(dir: string, out: string[] = []): string[] {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "build" || e.name === "dist") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) sources(full, out);
      else if (SOURCE.test(e.name)) out.push(full);
    }
    return out;
  }

  // Comment lines are skipped so the check does not trip on the prose that
  // explains it — including this file and the two that describe the deletion.
  // A re-added scaffold is CODE, and the runtime half catches the registration
  // wherever it is written, so nothing here depends on the scan alone.
  const codeLines = (file: string): { n: number; text: string }[] =>
    readFileSync(file, "utf-8")
      .split("\n")
      .map((text, i) => ({ n: i + 1, text }))
      .filter(({ text }) => {
        const t = text.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      });

  const rel = (f: string) => relative(root, f).split(sep).join("/");

  // Tests and checks are exempt from all three scans below, and have to be.
  // The two files that establish this rule NAME the strings it forbids: this
  // check carries them as needles, and `main/handlers/handlers.test.ts` names
  // the channel in the assertion that it is not registered. A scan that
  // counted those would be a guard that fails on its own enforcement. It costs
  // nothing here — the scaffold this is written against was production code,
  // and a fixture naming "1.0.0" is describing a scenario, not this build.
  const isFixture = (f: string) =>
    /\.(test|check)\.(ts|tsx|mts|mjs)$/.test(f) || rel(f).includes("/__tests__/");

  const files = ROOTS.flatMap((r) => sources(join(root, r))).filter((f) => !isFixture(f));

  const template = files.flatMap((f) =>
    codeLines(f)
      .filter(({ text }) => text.includes("My Glaze App"))
      .map(({ n }) => `${rel(f)}:${n}`),
  );
  assertNone(template, "no source states the template's app name");

  const getInfo = files.flatMap((f) =>
    codeLines(f)
      .filter(({ text }) => text.includes("app:getInfo"))
      .map(({ n }) => `${rel(f)}:${n}`),
  );
  assertNone(getInfo, "no source registers the template's app:getInfo channel");

  // A version the app STATES rather than reads. The changelog is the one
  // exemption, because writing versions down is what it is for.
  const CHANGELOG = "main/services/insights/release-notes.ts";
  const stated = files
    .filter((f) => rel(f) !== CHANGELOG)
    .flatMap((f) =>
      codeLines(f)
        .filter(({ text }) => /version\s*:\s*["'`]\d+\.\d+\.\d+["'`]/.test(text))
        .map(({ n, text }) => `${rel(f)}:${n} ${text.trim()}`),
    );
  assertNone(
    stated,
    "no source states an app version literal: the app READS app.getVersion(), which is " +
      `package.json's "version" (currently ${String(pkg.version)})`,
  );

  // And the one place the app reports a version to a user reads it that way.
  const insights = readFileSync(join(root, "main/services/insights/insights-service.ts"), "utf-8");
  assert(
    /appVersion:\s*\(\)\s*=>\s*app\.getVersion\(\)/.test(insights),
    "the insights report takes its app version from app.getVersion(), not a constant",
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
