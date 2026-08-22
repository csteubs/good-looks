// AI-proposed steps are VERIFIED against the live page before they are
// inserted — each run where it lands, the first that does not work stops the
// rest, and what worked is kept in a group named after the prompt.
//
// Driven through the real app because the subject only exists there: a live
// recording session, the real injected replayer acting on a real page, and the
// real step list the backend keeps. jsdom can host the dialog (that half is
// `generate-steps-dialog.test.tsx`, with the outcome stated), but it cannot
// host a step actually being tried. The model is not involved: the dialog's
// `onVerify` hands the backend a step list, and a stated list is what this
// hands it — one step that resolves, then one that cannot. That is exactly the
// list a model would produce on a page it half-understood, and the decision
// under test is what the app does with it.
//
// VERIFIED TO FAIL: insert every step regardless of `outcome.ok` and the first
// test reports `inserted: 2` with the unresolvable click in the list.

import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { test, expect, type AppFixtures } from "./fixtures.js";

interface Step {
  id: string;
  type: string;
  label?: string;
  locator?: { name?: string; v?: string };
}

interface VerifiedStepsResult {
  inserted: number;
  results: { label: string; status: "ran" | "unchecked" | "failed"; detail?: string }[];
  error?: string;
}

type Invoke = { glaze: { ipc: { invoke(channel: string, params?: unknown): Promise<unknown> } } };

async function servePage(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      '<!doctype html><title>agent</title>' +
        '<button id="a" onclick="document.getElementById(\'out\').textContent=\'clicked\'">First</button>' +
        '<p id="out"></p>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function invoke<T>(window: AppFixtures["window"], channel: string, params?: unknown): Promise<T> {
  return window.evaluate(
    async (args) =>
      (window as unknown as { glazeAPI: Invoke }).glazeAPI.glaze.ipc.invoke(
        args.channel,
        args.params,
      ) as Promise<T>,
    { channel, params },
  ) as Promise<T>;
}

function trainingPage(app: AppFixtures["app"]) {
  return app.windows().find((p) => p.url().startsWith("http://127.0.0.1"));
}

async function waitForPageReady(window: AppFixtures["window"]): Promise<void> {
  await expect
    .poll(async () => (await invoke<{ pageReady: boolean }>(window, "recorder:getState")).pageReady, {
      timeout: 20_000,
    })
    .toBe(true);
}

/** The list as a reader sees it: type, plus the name a click targets or the
 *  label a group carries. */
async function stepLabels(window: AppFixtures["window"]): Promise<string[]> {
  const steps = await invoke<Step[]>(window, "recorder:getSteps");
  return steps.map((s) =>
    s.type === "click" ? `click:${s.locator?.name ?? "?"}` : s.type === "group" ? `group:${s.label ?? ""}` : s.type,
  );
}

async function stopRecording(window: AppFixtures["window"]): Promise<void> {
  await invoke(window, "recorder:stop");
  await expect
    .poll(async () => (await invoke<{ recording: boolean }>(window, "recorder:getState")).recording, {
      timeout: 20_000,
    })
    .toBe(false);
}

const RESOLVES = { type: "click", locator: { k: "role", role: "button", name: "First" } };
const CANNOT = { type: "click", locator: { k: "role", role: "button", name: "Nowhere" } };

test("a proposed step that works is inserted; the first that does not stops the rest", async ({
  app,
  window,
}) => {
  const page = await servePage();
  try {
    await invoke(window, "recorder:start", { url: page.url, name: "agent repro" });
    await waitForPageReady(window);
    const browser = trainingPage(app)!;
    await browser.waitForLoadState("domcontentloaded");

    const outcome = await invoke<VerifiedStepsResult>(window, "recorder:verifySteps", {
      steps: [RESOLVES, CANNOT, RESOLVES],
      label: "click First, then a button that is not there",
    });

    expect(outcome.error).toBeUndefined();
    expect(outcome.inserted).toBe(1);
    expect(outcome.results.map((r) => r.status)).toEqual(["ran", "failed"]);
    expect(outcome.results[1].detail, "the failure says why").toBeTruthy();

    // The step really ran: the page shows the click's effect.
    await expect(browser.locator("#out")).toHaveText("clicked");

    // What landed: the one that worked, grouped under the prompt, the group
    // closed behind it — and NOT the unresolvable step, nor the one after it.
    expect(await stepLabels(window)).toEqual([
      "goto",
      "group:click First, then a button that is not there",
      "click:First",
      "endGroup",
    ]);

    // Capture was suspended: the verified click was recorded ONCE (as the
    // inserted step), not again by the capture script as a user click.
    expect((await stepLabels(window)).filter((l) => l === "click:First")).toHaveLength(1);
  } finally {
    await stopRecording(window).catch(() => {});
    await page.close();
  }
});

test("a run whose first step fails leaves the list exactly as it found it", async ({
  app,
  window,
}) => {
  const page = await servePage();
  try {
    await invoke(window, "recorder:start", { url: page.url, name: "agent repro" });
    await waitForPageReady(window);
    await trainingPage(app)!.waitForLoadState("domcontentloaded");

    const outcome = await invoke<VerifiedStepsResult>(window, "recorder:verifySteps", {
      steps: [CANNOT, RESOLVES],
      label: "nothing works",
    });

    expect(outcome.inserted).toBe(0);
    expect(outcome.results.map((r) => r.status)).toEqual(["failed"]);
    // No empty group: the marker is only written once something stands in it.
    expect(await stepLabels(window)).toEqual(["goto"]);
  } finally {
    await stopRecording(window).catch(() => {});
    await page.close();
  }
});

test("every step working inserts all of them, in order, in one group", async ({ app, window }) => {
  const page = await servePage();
  try {
    await invoke(window, "recorder:start", { url: page.url, name: "agent repro" });
    await waitForPageReady(window);
    await trainingPage(app)!.waitForLoadState("domcontentloaded");

    const outcome = await invoke<VerifiedStepsResult>(window, "recorder:verifySteps", {
      steps: [RESOLVES, { type: "assert", assert: "visible", locator: { k: "css", v: "#out" } }],
      label: "click First and see the output",
    });

    expect(outcome.inserted).toBe(2);
    expect(outcome.results.map((r) => r.status)).toEqual(["ran", "ran"]);
    expect(await stepLabels(window)).toEqual([
      "goto",
      "group:click First and see the output",
      "click:First",
      "assert",
      "endGroup",
    ]);
  } finally {
    await stopRecording(window).catch(() => {});
    await page.close();
  }
});
