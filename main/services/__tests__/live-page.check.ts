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
//
// SINCE 2026-08-24 it also proves the SHOPIFY CRAWLER SIGNATURE reaches the
// wire. `live-page-service.test.ts` proves the route is installed and merges
// the right headers onto a fake route; what it cannot prove is that real
// Playwright applies that route to a real navigation and that the header
// arrives — the same gap `e2e/shopify-signature.spec.ts` closes for the
// trainer. The failure is silent in both directions: an unsigned request to a
// protected storefront is answered with a perfectly good 200 serving the
// password page, so the only place the truth exists is at the far end of the
// socket. This check already has a socket.

import http from "node:http";
import type { AddressInfo } from "node:net";

import { livePageService, type LiveBrowserLike } from "../live-page-service.js";
import { shopifySignatureStore } from "../shopify-signature-store.js";
// Imported from the stub BY PATH, not through the `@shell/backend` alias: the
// alias resolves to the real shim at type-check time, which has no such export.
// Same idiom as variables.check.ts and alerts.check.ts.
import { setEncryptionAvailable } from "./shell-backend-stub.js";

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

    let st;
    try {
      st = await livePageService.open(url);
    } catch (err) {
      // No browser is a setup problem, not a finding: say what to run rather
      // than dumping an unhandled rejection. CI installs Chromium for this
      // check in gate.yml; locally, `npx playwright install chromium`.
      console.error(`FAIL could not launch Chromium: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      console.error("     run `npx playwright install chromium` and retry");
      process.exit(1);
    }
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

    // ── The crawler signature, on a real navigation ──────────────────
    //
    // A second server standing in for a password-protected storefront: it
    // serves the store to a signed request and the password page to an
    // unsigned one, which is what Shopify's bot wall actually does. The store
    // is registered for THIS server's authority (host:port — two ports are two
    // authorities, and the signature covers `@authority`), then the live page
    // is opened at it and asked what it is looking at.
    let sawSigned = 0;
    let sawUnsigned = 0;
    // A THIRD-PARTY authority the storefront loads from — a stand-in for
    // cdn.shopify.com or a merchant's analytics vendor. Two ports are two
    // authorities, which is the relationship that matters: the signature covers
    // `@authority`, so this one must never see it even while the page is armed.
    let thirdPartySigned = 0;
    let thirdPartyHits = 0;
    const thirdParty = http.createServer((req, res) => {
      thirdPartyHits++;
      if (req.headers["signature-input"] || req.headers["signature"]) thirdPartySigned++;
      res.setHeader("content-type", "image/gif");
      res.end();
    });
    await new Promise<void>((r) => thirdParty.listen(0, "127.0.0.1", r));
    const thirdPartyPort = (thirdParty.address() as AddressInfo).port;

    const wall = http.createServer((req, res) => {
      const isSigned = !!(req.headers["signature-input"] && req.headers["signature"]);
      if (isSigned) sawSigned++;
      else sawUnsigned++;
      res.setHeader("content-type", "text/html");
      res.end(
        `<!doctype html><html><head><title>${isSigned ? "Store" : "Locked"}</title></head>` +
          `<body><h1>${isSigned ? "Store home" : "Enter password"}</h1>` +
          `<img src="http://127.0.0.1:${thirdPartyPort}/pixel.gif"></body></html>`,
      );
    });
    await new Promise<void>((r) => wall.listen(0, "127.0.0.1", r));
    const wallPort = (wall.address() as AddressInfo).port;
    const wallUrl = `http://127.0.0.1:${wallPort}/`;
    try {
      // The control FIRST, before anything is registered: without it a green
      // signed case is equally consistent with a server that always says yes.
      const unsigned = await livePageService.open(wallUrl);
      assert(unsigned.title === "Locked", `unregistered: the wall holds (title ${JSON.stringify(unsigned.title)})`);
      await livePageService.close();

      // The signature store encrypts, and the stub defaults availability to
      // false so nothing exercises a persistence path by accident.
      setEncryptionAvailable(true);
      await shopifySignatureStore.upsert({
        host: `127.0.0.1:${wallPort}`,
        signatureInput:
          'sig1=("@authority");created=1735689600;expires=4102444799;keyid="kkk";alg="ed25519"',
        signature: "sig1=:dGhpcy1pcy10aGUtc2lnbmF0dXJl:",
      });
      const signed = await livePageService.open(wallUrl);
      assert(signed.title === "Store", `registered: the live page is signed in (title ${JSON.stringify(signed.title)})`);
      assert(sawSigned > 0, `the server really saw the signature headers (signed=${sawSigned})`);
      await livePageService.close();

      // THE PROPERTY THE EXACT-HOST RULE EXISTS FOR, on a real browser: while
      // the page is ARMED and signing the storefront, the third-party image it
      // pulls must go out unsigned. A row that merely opened at an unregistered
      // address would not test this — nothing is routed there at all, so it
      // reduces to "a plain page loads".
      assert(thirdPartyHits > 0, `the storefront really pulled from the third party (hits=${thirdPartyHits})`);
      assert(
        thirdPartySigned === 0,
        `a third-party authority is never offered the signature (signed=${thirdPartySigned})`,
      );

      const other = await livePageService.open(url);
      assert(other.title === "Live", "an unregistered address still loads");
      await livePageService.close();
      assert(sawUnsigned >= 1, `the control ran unsigned (unsigned=${sawUnsigned})`);
    } finally {
      wall.close();
      thirdParty.close();
      // Removal WRITES the encrypted blob too, so availability stays on until
      // this row's entry is gone — turning it off first strands the credential
      // on disk and throws out of the cleanup. Scoped to the host THIS row
      // registered rather than emptying the store: the stub's userData dir is
      // shared with other checks, and a cleanup that removes everything would
      // be a surprising thing for one row to do.
      await shopifySignatureStore.list().then(
        async (rows) => {
          for (const row of rows) {
            if (row.host === `127.0.0.1:${wallPort}`) await shopifySignatureStore.remove(row.id);
          }
        },
        () => {},
      );
      setEncryptionAvailable(false);
    }
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
