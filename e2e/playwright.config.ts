// End-to-end config for driving the packaged app itself.
//
// Deliberately NOT at the repo root. The app's own runner generates a
// `playwright.config.ts` next to the specs it executes (see
// `ensureConfig` in main/services/playwright-runner.ts) and passes it with an
// explicit `--config`, so a root config would not actually collide — but the
// two exist for entirely different purposes, and one of them being somewhere a
// reader has to go looking for is worth more than the shorter path.

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  // Each test launches its own Electron process against its own userData dir.
  // They are independent, but they are also heavyweight — a handful of app
  // launches in parallel on a CI runner is a good way to make a suite look
  // flaky when it is really just starved.
  workers: 1,
  fullyParallel: false,
  // An app launch and first paint is slower than a page load, and CI is slower
  // than a laptop. The default 30s is enough locally and not always enough
  // there, which is the classic "passes for me" failure.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // A failed assertion against a window nobody can see is very hard to read.
  // Traces and screenshots are the whole point of running this in CI.
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  // A retry masks a real intermittent bug in the app, which is exactly what
  // this suite exists to find. Fail honestly instead.
  retries: 0,
  forbidOnly: !!process.env.CI,
});
