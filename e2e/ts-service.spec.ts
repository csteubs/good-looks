// The TypeScript service in a REAL utilityProcess.
//
// `core.test.ts` proves the language service, `client.test.ts` the client
// over an in-process child, and `check:ts-service` boots the built child
// under plain Node. None of them forks through Electron's `utilityProcess`,
// which is the one path the app takes: a child script path computed from
// the main bundle's own location, a node_modules found the way the runner
// finds Playwright, and `process.parentPort` as the transport. If any of
// those is wrong the editor shows "Types unavailable" on every Script tab
// while every other test stays green — so this asks the running app.

import { test, expect } from "./fixtures.js";

type Api = { glaze: { ipc: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } } };

test("the app forks the TypeScript service and answers about a spec", async ({ window }) => {
  const status = await window.evaluate(() => (window as unknown as { glazeAPI: Api }).glazeAPI.glaze.ipc.invoke("ts:ensure"));
  expect(status, JSON.stringify(status)).toMatchObject({ available: true });
  expect((status as { typescript: string }).typescript).toMatch(/^5\./);

  const spec = 'import { test, expect } from "@playwright/test";\ntest("t", async ({ page }) => {\n  await page.\n  page.waitForTimeout(1);\n});\n';
  await window.evaluate(
    ({ spec }) => (window as unknown as { glazeAPI: Api }).glazeAPI.glaze.ipc.invoke("ts:update", { id: "e2e", text: spec }),
    { spec },
  );
  const completions = (await window.evaluate(
    ({ at }) => (window as unknown as { glazeAPI: Api }).glazeAPI.glaze.ipc.invoke("ts:completions", { id: "e2e", offset: at }),
    { at: spec.indexOf("page.") + 5 },
  )) as { label: string }[];
  expect(completions.map((c) => c.label)).toContain("getByRole");

  // A well-formed spec for the inspections: the half-typed member above
  // would parse `page.\n  page.waitForTimeout` as one awaited chain.
  const whole = 'import { test, expect } from "@playwright/test";\ntest("t", async ({ page }) => {\n  await page.goto("https://a.example");\n  page.waitForTimeout(1);\n});\n';
  await window.evaluate(
    ({ whole }) => (window as unknown as { glazeAPI: Api }).glazeAPI.glaze.ipc.invoke("ts:update", { id: "e2e", text: whole }),
    { whole },
  );
  const inspections = (await window.evaluate(() =>
    (window as unknown as { glazeAPI: Api }).glazeAPI.glaze.ipc.invoke("ts:inspections", { id: "e2e" }),
  )) as { rule: string; fix?: unknown }[];
  // Both the un-awaited call and the fixed wait are reported, each with a fix.
  expect(inspections.map((i) => i.rule)).toEqual(expect.arrayContaining(["missing-await", "no-wait-for-timeout"]));
  expect(inspections.every((i) => i.fix)).toBe(true);
});
