// THE REPORT: "click events still aren't recorded consistently, particularly
// when they involve navigation to another route."
//
// The page transitions and no step appears. Recovering from it is worse than
// the bug: the training browser's URL strip is read-only by design, so there is
// no Back button, and the user has to abandon the recording and start again —
// often to hit the same thing at the same click.
//
// ── Why this can only be checked end to end ────────────────────────────────
// The bug was a RACE, and every part of it is real-browser machinery. The click
// was captured correctly; the step was then left in the document the click was
// destroying, and the backend's read of it lost to the navigation. Nothing in a
// unit test has a navigation, a renderer process, or an asynchronous read that
// can arrive after a document is gone. The page-side rules are pinned in
// capture-egress.dom.test.ts; this asks the only question that test cannot —
// does the app end up with the step?
//
// VERIFIED TO FAIL against the previous implementation: with the DOM queue as
// the only channel, "records every click across a chain of routes" drops steps
// (which ones varies — that is what "inconsistently" meant), and "records a
// click a router intercepts" records nothing at all.

import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { test, expect, type AppFixtures } from "./fixtures.js";

interface Step {
  id: string;
  type: string;
  locator?: { name?: string; v?: string };
}

type Invoke = { glaze: { ipc: { invoke(channel: string, params?: unknown): Promise<unknown> } } };

/** How many hops the chain test walks. Long enough that an intermittent loss
 *  shows up rather than passing on a lucky run — the reported symptom was that
 *  SOME clicks survived. */
const CHAIN_LENGTH = 6;

function page(body: string, head = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
}

/**
 * A small site to record against.
 *
 * Every route is a real HTTP document, so a click on a link is a real
 * cross-document navigation — the thing that used to eat the step. `/router`
 * and `/spa` are the two ways a modern site takes that click over.
 */
async function serveSite(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    res.writeHead(200, { "content-type": "text/html" });

    const hop = /^\/hop\/(\d+)$/.exec(path);
    if (hop) {
      const n = Number(hop[1]);
      const next = n + 1;
      res.end(
        page(
          n < CHAIN_LENGTH
            ? `<h1>Hop ${n}</h1><a href="/hop/${next}" id="next">Hop to ${next}</a>`
            : `<h1>Hop ${n}</h1><p>End of the chain</p>`,
        ),
      );
      return;
    }

    if (path === "/router") {
      // A client-side router: it takes the click over at WINDOW capture, stops
      // it reaching anything else, and navigates itself. Before this fix the
      // recorder's listeners were on `document` only, so this click was never
      // seen at all — the page moved and the step list did not.
      res.end(
        page(
          `<h1>Router</h1><a href="/routed" id="go">Routed link</a>`,
          `<script>
             window.addEventListener("click", function (e) {
               var a = e.target.closest && e.target.closest("a");
               if (!a) return;
               e.preventDefault();
               e.stopPropagation();
               window.location.assign(a.getAttribute("href"));
             }, true);
           </script>`,
        ),
      );
      return;
    }
    if (path === "/routed") {
      res.end(page(`<h1>Routed</h1>`));
      return;
    }

    if (path === "/spa") {
      // Same document, new route: history.pushState. No unload, no new
      // document — the case that must keep working, and the one whose sequence
      // numbering continues rather than restarting.
      res.end(
        page(
          `<h1 id="view">Home</h1><button id="to-cart">Go to cart</button>`,
          `<script>
             document.addEventListener("click", function (e) {
               if (e.target.id !== "to-cart") return;
               history.pushState({}, "", "/spa/cart");
               document.getElementById("view").textContent = "Cart";
             });
           </script>`,
        ),
      );
      return;
    }

    res.end(page(`<h1>Start</h1><a href="/hop/1" id="start">Start the chain</a>`));
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

/** The training browser's own page — a WebContentsView target, found by URL.
 *  See the longer note in retrain-capture.spec.ts. */
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

/** Step labels: a click's accessible name, so order is readable in a diff. */
async function stepLabels(window: AppFixtures["window"]): Promise<string[]> {
  const steps = await invoke<Step[]>(window, "recorder:getSteps");
  return steps.map((s) => (s.type === "click" ? `click:${s.locator?.name ?? "?"}` : s.type));
}

test("records every click across a chain of routes", async ({ app, window }) => {
  const site = await serveSite();
  try {
    await invoke(window, "recorder:start", { url: site.url, name: "route chain" });
    await waitForPageReady(window);
    const browser = trainingPage(app)!;
    await browser.waitForLoadState("domcontentloaded");

    const expected = ["goto", "click:Start the chain"];
    await browser.click("#start");
    await browser.waitForURL(/\/hop\/1$/);

    for (let n = 1; n < CHAIN_LENGTH; n++) {
      // Each click destroys the document that captured it. That is the whole
      // bug: the step has to be out of the page before the navigation lands.
      await browser.click("#next");
      await browser.waitForURL(new RegExp(`/hop/${n + 1}$`));
      expected.push(`click:Hop to ${n + 1}`);
    }

    // Polled, not read once: the two channels are asynchronous and the last
    // click's step may still be in flight. What is asserted is that it ARRIVES,
    // and in the order the user performed it.
    await expect.poll(() => stepLabels(window), { timeout: 15_000 }).toEqual(expected);

    // Nothing arrived twice. Two channels deliver every one of these steps, so
    // a duplicate here is as real a failure as a loss — and it would replay as
    // a test that clicks through the chain twice.
    const steps = await invoke<Step[]>(window, "recorder:getSteps");
    expect(steps.length).toBe(expected.length);

    await invoke(window, "recorder:discardExit");
  } finally {
    await site.close();
  }
});

test("records a click a client-side router intercepts", async ({ app, window }) => {
  const site = await serveSite();
  try {
    await invoke(window, "recorder:start", { url: `${site.url}router`, name: "router" });
    await waitForPageReady(window);
    const browser = trainingPage(app)!;
    await browser.waitForLoadState("domcontentloaded");

    await browser.click("#go");
    await browser.waitForURL(/\/routed$/);

    // The page's own handler ran first, cancelled the link, stopped propagation
    // and navigated. The step is recorded regardless — the recorder's listener
    // is on `window`, which is the earliest target in the capture phase.
    await expect
      .poll(() => stepLabels(window), { timeout: 15_000 })
      .toEqual(["goto", "click:Routed link"]);

    await invoke(window, "recorder:discardExit");
  } finally {
    await site.close();
  }
});

test("records a click that changes route without changing document", async ({ app, window }) => {
  const site = await serveSite();
  try {
    await invoke(window, "recorder:start", { url: `${site.url}spa`, name: "spa" });
    await waitForPageReady(window);
    const browser = trainingPage(app)!;
    await browser.waitForLoadState("domcontentloaded");

    await browser.click("#to-cart");
    await expect(browser.locator("#view")).toHaveText("Cart");

    await expect
      .poll(() => stepLabels(window), { timeout: 15_000 })
      .toEqual(["goto", "click:Go to cart"]);

    // The URL the trainer reports follows a pushState route change; the step
    // list does not gain a phantom navigation step for it.
    await expect
      .poll(async () => (await invoke<{ url: string }>(window, "recorder:getState")).url)
      .toContain("/spa");

    await invoke(window, "recorder:discardExit");
  } finally {
    await site.close();
  }
});

test("keeps recording after the page strips the recorder's attributes", async ({ app, window }) => {
  const site = await serveSite();
  try {
    await invoke(window, "recorder:start", { url: `${site.url}spa`, name: "hostile" });
    await waitForPageReady(window);
    const browser = trainingPage(app)!;
    await browser.waitForLoadState("domcontentloaded");

    // A site can rewrite its own <html> element's attributes — some frameworks
    // do it on hydration, and a hostile one would do it deliberately. Capture
    // state lives in the recorder's isolated world instead, where the page
    // cannot reach it.
    await browser.evaluate(() => {
      for (const attr of [...document.documentElement.attributes]) {
        document.documentElement.removeAttribute(attr.name);
      }
    });

    await browser.click("#to-cart");
    await expect
      .poll(() => stepLabels(window), { timeout: 15_000 })
      .toEqual(["goto", "click:Go to cart"]);

    await invoke(window, "recorder:discardExit");
  } finally {
    await site.close();
  }
});
