// Does the live page get Playwright's own answers from a REAL browser?
//
//   npm run check:live-page
//
// `live-page-service.test.ts` proves the service's contract against a fake
// browser; what it cannot prove is the one thing the feature exists for —
// that the expression the generator spells for a locator MODEL is one the
// real library accepts and resolves to the elements the trainer's oracle
// would also find. So this launches headless Chromium from node_modules
// (the same library the app imports), serves a page, and asks.
//
// `pickLocator` is not driven: it waits for a human click and needs a headed
// browser. Its parse path is covered by the unit test.

import http from "node:http";
import type { AddressInfo } from "node:net";

import { livePageService, type LiveBrowserLike } from "../live-page-service.js";

let failures = 0;
function assert(ok: boolean, label: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
}

const PAGE = `<!doctype html><html><head><title>Live</title></head><body>
  <h1>Products</h1>
  <button data-testid="go">Search</button>
  <button>Other</button><button>Another</button>
  <label for="q">Search products</label><input id="q" />
  <div data-testid="deep" style="margin-top:3000px">Deep</div>
</body></html>`;

(async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    const { chromium } = await import("playwright");
    livePageService.useLauncher(async () => (await chromium.launch({ headless: true })) as unknown as LiveBrowserLike);

    const st = await livePageService.open(url);
    assert(st.open && st.url === url, `opened at ${url}`);
    assert(st.title === "Live", `read the title (got ${JSON.stringify(st.title)})`);

    const counts = await livePageService.countMany([
      { k: "testid", v: "go" },
      { k: "role", role: "button" },
      { k: "role", role: "button", name: "Search" },
      { k: "label", v: "Search products" },
      { k: "text", v: "Gone" },
      { k: "css", v: "h1" },
    ]);
    assert(counts[0].count === 1, `testid "go" matches once (got ${JSON.stringify(counts[0])})`);
    assert(counts[1].count === 3, `role button matches all three (got ${JSON.stringify(counts[1])})`);
    assert(counts[2].count === 1, `role button named Search matches once (got ${JSON.stringify(counts[2])})`);
    assert(counts[3].count === 1, `label matches the input (got ${JSON.stringify(counts[3])})`);
    assert(counts[4].count === 0, `text "Gone" matches nothing (got ${JSON.stringify(counts[4])})`);
    assert(counts[5].count === 1, `css h1 matches once (got ${JSON.stringify(counts[5])})`);

    // highlight must not throw, for a match, for no match, and for clear.
    await livePageService.highlight({ k: "testid", v: "deep" });
    await livePageService.highlight({ k: "text", v: "Gone" });
    await livePageService.highlight(null);
    assert(true, "highlight: a match, no match, and clear all return");

    await livePageService.close();
    assert(!livePageService.status().open, "closed");
    const after = await livePageService.countMany([{ k: "testid", v: "go" }]);
    assert(after[0].count === null, "a count with no live page is null, not a throw");
  } finally {
    server.close();
    await livePageService.close().catch(() => {});
    livePageService.useLauncher(null);
  }
  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll live-page checks passed.");
})();
