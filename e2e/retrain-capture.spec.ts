// REPRO: what actually happens to a step recorded while re-training a test.
//
// The report: opening an existing test in the trainer shows "Editing", and
// clicking in the training browser appears to record nothing. Only the real app
// can answer that — the capture path is an injected script in a real page,
// drained off a DOM attribute by a real poll.

import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { test, expect, type AppFixtures } from "./fixtures.js";

interface Step {
  id: string;
  type: string;
  locator?: { name?: string; v?: string };
}

type Invoke = { glaze: { ipc: { invoke(channel: string, params?: unknown): Promise<unknown> } } };

/** Three pages, so a seeded test has a flow to walk rather than one button. */
async function servePages(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    res.writeHead(200, { "content-type": "text/html" });
    if (path === "/two") {
      res.end('<!doctype html><title>two</title><button id="b">Second</button>');
    } else if (path === "/three") {
      res.end('<!doctype html><title>three</title><button id="c">Third</button>');
    } else {
      res.end('<!doctype html><title>one</title><button id="a">First</button>');
    }
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

/**
 * The training browser's own page, found by URL.
 *
 * `app.windows()` enumerates every page-like target the Electron app exposes,
 * which includes the WebContentsView the training page moved into when the
 * browser grew a URL strip — the view is a separate target with the site's URL,
 * while the window that contains it reports the strip's `app://` one. So the
 * URL match is still the right question; what changed is that the answer is no
 * longer a window. If this ever returns undefined, check that first: every
 * assertion downstream fails on a null page and reads like capture breaking.
 */
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

/** Step labels: the click's accessible name, so order is readable in a diff. */
async function stepLabels(window: AppFixtures["window"]): Promise<string[]> {
  const steps = await invoke<Step[]>(window, "recorder:getSteps");
  return steps.map((s) => (s.type === "click" ? `click:${s.locator?.name ?? "?"}` : s.type));
}

/** Record a three-click test and save it. Returns its id. */
async function seedTest(
  app: AppFixtures["app"],
  window: AppFixtures["window"],
  url: string,
): Promise<string> {
  await invoke(window, "recorder:start", { url, name: "retrain repro" });
  await waitForPageReady(window);
  const browser = trainingPage(app)!;
  await browser.waitForLoadState("domcontentloaded");

  // Three clicks on one page — no navigation, so the seed is about ORDER only.
  await browser.click("#a");
  await expect.poll(() => stepLabels(window), { timeout: 15_000 }).toEqual([
    "goto",
    "click:First",
  ]);
  await browser.evaluate(() => {
    document.body.innerHTML =
      '<button id="b">Second</button><button id="c">Third</button>';
  });
  await browser.click("#b");
  await browser.click("#c");
  await expect
    .poll(() => stepLabels(window), { timeout: 15_000 })
    .toEqual(["goto", "click:First", "click:Second", "click:Third"]);

  const testId = (await invoke<{ testId: string }>(window, "recorder:getState")).testId;
  await invoke(window, "recorder:stop");
  await expect
    .poll(async () => (await invoke<{ recording: boolean }>(window, "recorder:getState")).recording, {
      timeout: 20_000,
    })
    .toBe(false);
  return testId;
}

test("a step recorded after replaying the test lands after it, not before", async ({
  app,
  window,
}) => {
  const pages = await servePages();
  try {
    const testId = await seedTest(app, window, pages.url);

    await invoke(window, "recorder:start", { url: pages.url, name: "retrain repro", testId });
    await waitForPageReady(window);
    expect((await invoke<{ editing: boolean }>(window, "recorder:getState")).editing).toBe(true);

    // What a user re-training a test actually does: replay to reach the state
    // they want to extend from, then interact.
    const browser = trainingPage(app)!;
    await browser.waitForLoadState("domcontentloaded");
    await browser.evaluate(() => {
      document.body.innerHTML =
        '<button id="a">First</button><button id="b">Second</button><button id="c">Third</button>';
    });
    const replay = await invoke<{ ok: boolean; error?: string }>(
      window,
      "recorder:replayFromCurrent",
      { startIndex: 0 },
    );
    expect(replay.ok, `replay error: ${replay.error ?? ""}`).toBe(true);

    await browser.evaluate(() => {
      document.body.innerHTML = '<button id="new">Brand new</button>';
    });
    await browser.click("#new");

    await expect
      .poll(async () => (await invoke<Step[]>(window, "recorder:getSteps")).length, {
        timeout: 15_000,
      })
      .toBe(5);

    // THE BUG: this used to be [goto, Brand new, First, Second, Third] — a step
    // recorded in the END state, written into the spec before the steps that
    // reach it. Nothing errors; the order is wrong until the test is run.
    expect(await stepLabels(window)).toEqual([
      "goto",
      "click:First",
      "click:Second",
      "click:Third",
      "click:Brand new",
    ]);

    await invoke(window, "recorder:discardExit");
  } finally {
    await pages.close();
  }
});

test("a step recorded without replaying lands at the cursor, just past the navigation", async ({
  app,
  window,
}) => {
  const pages = await servePages();
  try {
    const testId = await seedTest(app, window, pages.url);

    await invoke(window, "recorder:start", { url: pages.url, name: "retrain repro", testId });
    await waitForPageReady(window);

    const browser = trainingPage(app)!;
    await browser.waitForLoadState("domcontentloaded");
    await browser.evaluate(() => {
      document.body.innerHTML = '<button id="new">Brand new</button>';
    });
    await browser.click("#new");

    await expect
      .poll(async () => (await invoke<Step[]>(window, "recorder:getSteps")).length, {
        timeout: 15_000,
      })
      .toBe(5);

    // NOT a bug, and pinned so it is not "fixed" into an append: nothing has
    // been replayed, so the browser really is on the first page, and a step
    // recorded there belongs where the browser is. What was missing is any way
    // to SEE that — the trainers now scroll the arriving row into view and name
    // the insert point (see check:insert-cursor).
    expect(await stepLabels(window)).toEqual([
      "goto",
      "click:Brand new",
      "click:First",
      "click:Second",
      "click:Third",
    ]);

    await invoke(window, "recorder:discardExit");
  } finally {
    await pages.close();
  }
});

test("replaying the test moves the insert cursor past what it replayed", async ({
  app,
  window,
}) => {
  const pages = await servePages();
  try {
    const testId = await seedTest(app, window, pages.url);

    await invoke(window, "recorder:start", { url: pages.url, name: "retrain repro", testId });
    await waitForPageReady(window);

    // What a user does to reach the state they want to extend from.
    const browser = trainingPage(app)!;
    await browser.waitForLoadState("domcontentloaded");
    await browser.evaluate(() => {
      document.body.innerHTML =
        '<button id="a">First</button><button id="b">Second</button><button id="c">Third</button>';
    });
    const replay = await invoke<{ ok: boolean; ranCount: number; error?: string }>(
      window,
      "recorder:replayFromCurrent",
      { startIndex: 0 },
    );
    expect(replay.ok, `replay error: ${replay.error ?? ""}`).toBe(true);

    // The browser has now executed every step. The cursor has to say so, or the
    // next captured step is ordered before the steps that reached this state.
    const state = await invoke<{ cursor: number }>(window, "recorder:getState");
    expect(state.cursor, "the cursor sits past the replayed steps").toBe(4);

    await invoke(window, "recorder:discardExit");
  } finally {
    await pages.close();
  }
});

// ── The wider action vocabulary: a double-click and a drag ─────────────────
//
// Both are claims about a SEQUENCE the browser produces, and only a real one
// produces it. `main/recorder/recorded-actions.dom.test.ts` covers the same
// ground against jsdom with SYNTHESIZED events; what that cannot answer is
// whether a genuine double-click — two real clicks and then a dblclick, at real
// speed — comes out as ONE step, or as the three the page actually fired.

/** A page with something to double-click and something to drag. Served fresh
 *  so the gestures below act on known geometry rather than on whatever the
 *  three-page fixture above happens to be showing. */
async function serveBoard(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      '<!doctype html><title>board</title>' +
        '<button id="row" data-testid="row" style="position:absolute;left:0;top:0;width:120px;height:40px">Row</button>' +
        '<div id="card" data-testid="card" style="position:absolute;left:0;top:80px;width:80px;height:60px;background:#ddd">Card</div>' +
        '<div id="done" data-testid="done" style="position:absolute;left:300px;top:80px;width:120px;height:60px;background:#eee">Done</div>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function stepTypes(window: AppFixtures["window"]): Promise<string[]> {
  return (await invoke<Step[]>(window, "recorder:getSteps")).map((s) => s.type);
}

test("a real double-click records ONE step, not the two clicks the browser fired first", async ({
  app,
  window,
}) => {
  const site = await serveBoard();
  try {
    await invoke(window, "recorder:start", { url: site.url, name: "dblclick" });
    await waitForPageReady(window);
    const browser = trainingPage(app)!;
    await browser.waitForLoadState("domcontentloaded");

    await browser.dblclick("#row");

    // The two clicks leave the page BEFORE the dblclick does — that is the fix
    // for the click that navigates, and it must not be undone by holding one
    // back. So they arrive, and are withdrawn when the double-click claims
    // them. Polling for stability rather than for a first sighting: a snapshot
    // taken between the second click and the dblclick would see them.
    await expect
      .poll(() => stepTypes(window), { timeout: 15_000 })
      .toEqual(["goto", "dblclick"]);

    await invoke(window, "recorder:discardExit");
  } finally {
    await site.close();
  }
});

test("a real drag records one drag step with both ends", async ({ app, window }) => {
  const site = await serveBoard();
  try {
    await invoke(window, "recorder:start", { url: site.url, name: "drag" });
    await waitForPageReady(window);
    const browser = trainingPage(app)!;
    await browser.waitForLoadState("domcontentloaded");

    // A real pointer gesture, slow enough and far enough to clear both
    // thresholds. Steps in the middle, because a single jump from press to
    // release is not what a person's hand does and not what an application
    // built on pointermove would see.
    const from = (await browser.locator("#card").boundingBox())!;
    const to = (await browser.locator("#done").boundingBox())!;
    await browser.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await browser.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await browser.mouse.move(
        from.x + ((to.x - from.x) * i) / 6 + 20,
        from.y + ((to.y - from.y) * i) / 6 + 20,
      );
      await browser.waitForTimeout(120);
    }
    await browser.mouse.up();

    await expect
      .poll(
        async () => {
          const steps = await invoke<Step[]>(window, "recorder:getSteps");
          const drag = steps.find((s) => s.type === "drag") as
            | (Step & { toLocator?: { v?: string } })
            | undefined;
          return drag ? [drag.locator?.v, drag.toLocator?.v] : null;
        },
        { timeout: 15_000 },
      )
      .toEqual(["card", "done"]);

    await invoke(window, "recorder:discardExit");
  } finally {
    await site.close();
  }
});
