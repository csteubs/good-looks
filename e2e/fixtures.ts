// Launching the real app, with its state somewhere disposable.
//
// The app reads and writes a single userData directory: the test library, run
// history, heal journal, AI debug sessions, settings. Pointing a test at the
// default one would run retention against the developer's own recorded tests
// and reconcile their batch history — destructive, and it makes the suite's
// result depend on whatever happens to be in there.
//
// `--user-data-dir` is the lever rather than an env var or an app.setPath call,
// because Electron applies it before any application code runs. That matters
// here specifically: main/index.ts sweeps retention and reconciles interrupted
// batches at MODULE SCOPE, before app.whenReady(), so anything that redirects
// the path from inside the app would already be too late.

import { test as base, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface AppFixtures {
  app: ElectronApplication;
  window: Page;
  /** The throwaway userData dir this test's app instance is using. */
  userDataDir: string;
}

export const test = base.extend<AppFixtures>({
  // Playwright reads a fixture's dependencies off its destructuring pattern, so
  // "depends on nothing" has to be written as an empty one. `_` in its place
  // would be a different signature, not a tidier spelling of this.
  // eslint-disable-next-line no-empty-pattern
  userDataDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "good-looks-e2e-"));
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },

  app: async ({ userDataDir }, use, testInfo) => {
    const mainEntry = path.join(repoRoot, "build", "main", "index.js");
    if (!fs.existsSync(mainEntry)) {
      throw new Error(
        `No built main process at ${mainEntry}.\n` +
          "The e2e suite drives the real app, so it needs a build first: npm run build",
      );
    }

    const app = await electron.launch({
      args: [
        repoRoot,
        `--user-data-dir=${userDataDir}`,
        // Make Electron's safeStorage available on a headless Linux CI runner,
        // which has no system keyring — without it `isEncryptionAvailable()` is
        // false and any test that stores an encrypted secret (basic auth,
        // TOTP) fails with "Secure storage is unavailable". The `basic` backend
        // is a hardcoded-key store that is always available; it only affects
        // this test process, never a real install.
        "--password-store=basic",
      ],
      env: {
        ...process.env,
        // The suite asserts on the app's own behaviour. A developer's real
        // provider config would make "is the model list empty" depend on
        // whether Ollama happens to be running on this machine.
        GOOD_LOOKS_E2E: "1",
      },
    });

    // The main process log is where a renderer that failed to load says so —
    // the app:// scheme exists precisely because a CORS-blocked renderer
    // produces a blank window and an otherwise clean log. Attaching it makes a
    // failure readable instead of a mystery screenshot.
    const mainLog: string[] = [];
    app.process().stdout?.on("data", (d) => mainLog.push(String(d)));
    app.process().stderr?.on("data", (d) => mainLog.push(String(d)));

    await use(app);

    if (testInfo.status !== testInfo.expectedStatus && mainLog.length > 0) {
      await testInfo.attach("main-process.log", { body: mainLog.join(""), contentType: "text/plain" });
    }
    await app.close();
  },

  window: async ({ app }, use) => {
    const window = await app.firstWindow();
    // Renderer console errors are forwarded to the main log in this build, but
    // surfacing them per-test is what turns "the button did nothing" into a
    // stack trace.
    window.on("pageerror", (err) => console.error("[renderer pageerror]", err.message));
    await window.waitForLoadState("domcontentloaded");
    await use(window);
  },
});

export { expect } from "@playwright/test";
