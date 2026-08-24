// Does the TRAINER actually put the Shopify crawler signature on the wire?
//
// DECISIONS 2026-08-18 left this to a manual pass — "the trainer hook's real
// subject (Chromium actually attaching the header) would need a live HTTP
// server under e2e/" — and settled for source-level assertions in
// `check:shopify-signature` about the two properties Electron's API makes
// silent (one listener slot per session; a callback that must fire on every
// path). Those pin the hook's SHAPE. Neither they nor any unit test can answer
// the question a user actually asks, which is whether the header arrived.
//
// It is worth a real server because the failure is invisible from inside the
// app in BOTH directions. A store with crawler protection does not refuse an
// unsigned trainer with an error; it serves the password page, which is a
// perfectly good 200. And a session that signed every request logs exactly what
// a session that signed none logs. So the only place the truth exists is at the
// other end of the socket, and this is that end: a server that serves the store
// to a signed request and "Enter password" to an unsigned one, and remembers
// which it did.
//
// The negative cases carry as much weight as the positive one. Without "no
// signature registered → the password page", the passing case proves only that
// the server always says Store home. Without the third-party host, the passing
// case is equally consistent with a trainer that attaches the credential to
// every request it makes — which is the thing `signatureForUrl`'s exact-host
// rule exists to prevent, since presenting a signature at an authority it was
// not issued for is an INVALID signature offered to a verifier whose job is
// spotting bot spoofing.
//
// VERIFIED TO FAIL: disabling the `onBeforeSendHeaders` registration in
// recorder-service.ts fails three of the four rows (the wall row still passes,
// which is what it is for); making `normalizeSignatureHost` return `hostname`
// instead of `host` — i.e. dropping the port, which the module's own comment
// calls out as part of the authority — fails "a third-party host is never
// offered the signature". Noted because the obvious mutation does NOT reach
// that row: the two servers here differ only by port, so widening the host
// test to a suffix match leaves it green.

import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type AppFixtures } from "./fixtures.js";

/** A signature value shaped like a real one: base64 in an RFC 8941 Byte
 *  Sequence, and a `Signature-Input` whose `expires` is far enough out that
 *  this suite does not start failing on a date. */
const SIGNATURE = "sig1=:dGhpcy1pcy10aGUtc2lnbmF0dXJl:";
const SIGNATURE_INPUT =
  'sig1=("@authority");created=1735689600;expires=4102444799;keyid="kkk";alg="ed25519"';
/** What the store fills in when the paste leaves Signature-Agent empty — the
 *  quotes included, since the header is a structured-field String. */
const SIGNATURE_AGENT = '"https://shopify.com"';

interface Store {
  url: string;
  host: string;
  /** Every request, in order: `<path> <signed|unsigned>`. */
  seen: () => string[];
  signed: () => number;
  unsigned: () => number;
  close: () => Promise<void>;
}

/**
 * A password-protected storefront.
 *
 * `/` redirects, exactly as a real one does, so the redirect HOP is covered —
 * that hop is a separate request with its own listener callback, and hooking a
 * navigation instead of the session is precisely how it would be missed. The
 * page then pulls a subresource and offers a link, so an ordinary page load and
 * an ordinary click are both measured.
 *
 * `thirdParty` is the same server under a second origin's eyes: the page loads
 * an image from it, and it must never see the credential.
 */
async function startStore(thirdPartyUrl?: string): Promise<Store> {
  const seen: string[] = [];
  let signed = 0;
  let unsigned = 0;
  const server = http.createServer((req, res) => {
    // The VALUES, not merely the presence of the header names. Presence alone
    // would call a request signed when the app sent an empty, truncated or
    // wrong-entry credential — which is a way this feature could break that
    // looks identical from the outside.
    const isSigned =
      req.headers["signature-input"] === SIGNATURE_INPUT &&
      req.headers["signature"] === SIGNATURE &&
      req.headers["signature-agent"] === SIGNATURE_AGENT;
    seen.push(`${req.url} ${isSigned ? "signed" : "unsigned"}`);
    if (isSigned) signed++;
    else unsigned++;
    if (req.url === "/") {
      res.writeHead(302, { location: "/home" });
      res.end();
      return;
    }
    if (req.url === "/pixel.png") {
      res.writeHead(200, { "content-type": "image/gif" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><title>storefront</title>` +
        `<h1>${isSigned ? "Store home" : "Enter password"}</h1>` +
        `<img src="/pixel.png">` +
        (thirdPartyUrl ? `<img src="${thirdPartyUrl}pixel.png">` : "") +
        `<a id="go" href="/collections">Collections</a>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    host: `127.0.0.1:${port}`,
    seen: () => seen,
    signed: () => signed,
    unsigned: () => unsigned,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

type Invoke = { glaze: { ipc: { invoke(channel: string, params?: unknown): Promise<unknown> } } };

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

/** The training browser: the only window in this app pointed at the site. */
function trainingPage(app: AppFixtures["app"]) {
  return app.windows().find((p) => p.url().startsWith("http://127.0.0.1"));
}

async function waitForPageReady(window: AppFixtures["window"]): Promise<void> {
  await expect
    .poll(
      async () => (await invoke<{ pageReady: boolean }>(window, "recorder:getState")).pageReady,
      { timeout: 20_000 },
    )
    .toBe(true);
}

async function stopRecording(window: AppFixtures["window"]): Promise<void> {
  await invoke(window, "recorder:stop");
  await expect
    .poll(
      async () => (await invoke<{ recording: boolean }>(window, "recorder:getState")).recording,
      { timeout: 20_000 },
    )
    .toBe(false);
}

test("the trainer signs every hop of a training session", async ({ app, window }) => {
  const store = await startStore();
  try {
    await invoke(window, "shopify:add", {
      host: store.host,
      signatureInput: SIGNATURE_INPUT,
      signature: SIGNATURE,
    });

    await invoke(window, "recorder:start", { url: store.url, name: "storefront" });
    await waitForPageReady(window);
    const browser = trainingPage(app)!;
    await browser.waitForLoadState("domcontentloaded");

    // The page the user is looking at is the STORE, not the password wall.
    // Everything else here is evidence for this one line.
    await expect(browser.locator("h1")).toHaveText("Store home");

    // A click that navigates: the recorder intercepts `will-navigate` and
    // re-issues the load itself, which is a second way the header could be
    // dropped and is not covered by the first navigation.
    await browser.click("#go");
    await browser.waitForLoadState("domcontentloaded");
    // The URL as well as the heading: both pages say "Store home", so the
    // heading alone cannot tell the post-click page from the pre-click one and
    // would pass against a click that navigated nowhere.
    await expect.poll(() => new URL(browser.url()).pathname).toBe("/collections");
    await expect(browser.locator("h1")).toHaveText("Store home");

    await stopRecording(window);

    // The redirect hop and the subresource, named individually — a total would
    // pass with any one of them unsigned.
    const seen = store.seen();
    expect(seen, `requests:\n${seen.join("\n")}`).toContain("/ signed");
    expect(seen, `requests:\n${seen.join("\n")}`).toContain("/home signed");
    expect(seen, `requests:\n${seen.join("\n")}`).toContain("/pixel.png signed");
    expect(seen, `requests:\n${seen.join("\n")}`).toContain("/collections signed");
    expect(store.unsigned(), `requests:\n${seen.join("\n")}`).toBe(0);
  } finally {
    await stopRecording(window).catch(() => {});
    await store.close();
  }
});

test("…and is honestly stopped by the wall when no signature is registered", async ({
  app,
  window,
}) => {
  // The control. Without it the test above proves only that this server always
  // says "Store home", and the whole suite would keep passing if the trainer
  // stopped sending anything at all.
  const store = await startStore();
  try {
    await invoke(window, "recorder:start", { url: store.url, name: "storefront" });
    await waitForPageReady(window);
    const browser = trainingPage(app)!;
    await browser.waitForLoadState("domcontentloaded");
    await expect(browser.locator("h1")).toHaveText("Enter password");
    await stopRecording(window);
    expect(store.signed(), `requests:\n${store.seen().join("\n")}`).toBe(0);
  } finally {
    await stopRecording(window).catch(() => {});
    await store.close();
  }
});

test("a third-party host the storefront loads from is never offered the signature", async ({
  app,
  window,
}) => {
  // Two servers on two ports, which is two AUTHORITIES — the signature covers
  // `@authority`, so this is the same relationship a storefront has with
  // cdn.shopify.com or a merchant's analytics vendor. Only the registered one
  // may see the credential.
  const cdn = await startStore();
  const store = await startStore(cdn.url);
  try {
    await invoke(window, "shopify:add", {
      host: store.host,
      signatureInput: SIGNATURE_INPUT,
      signature: SIGNATURE,
    });

    await invoke(window, "recorder:start", { url: store.url, name: "storefront" });
    await waitForPageReady(window);
    const browser = trainingPage(app)!;
    await browser.waitForLoadState("domcontentloaded");
    await expect(browser.locator("h1")).toHaveText("Store home");
    // The third-party request is a subresource, so wait for it to have happened
    // rather than assuming it raced the document.
    await expect.poll(() => cdn.seen().length, { timeout: 10_000 }).toBeGreaterThan(0);
    await stopRecording(window);

    expect(cdn.signed(), `cdn requests:\n${cdn.seen().join("\n")}`).toBe(0);
    expect(store.unsigned(), `store requests:\n${store.seen().join("\n")}`).toBe(0);
  } finally {
    await stopRecording(window).catch(() => {});
    await store.close();
    await cdn.close();
  }
});

test("reopening an existing test for training signs it too", async ({ app, window }) => {
  // The path a user is on when they say "I open the browser for training": the
  // test already exists, so `start` runs with `editing: true` and a step list.
  // It is a different branch of the same function, and the branch that skips
  // adding the initial `goto` — worth its own row, because "the signature is
  // sent on a NEW recording" is not the claim anyone is relying on.
  const store = await startStore();
  try {
    await invoke(window, "shopify:add", {
      host: store.host,
      signatureInput: SIGNATURE_INPUT,
      signature: SIGNATURE,
    });

    await invoke(window, "recorder:start", { url: store.url, name: "storefront" });
    await waitForPageReady(window);
    const testId = (await invoke<{ testId: string }>(window, "recorder:getState")).testId;
    await stopRecording(window);

    const before = store.seen().length;
    await invoke(window, "recorder:start", { url: store.url, name: "storefront", testId });
    await waitForPageReady(window);
    const browser = trainingPage(app)!;
    await browser.waitForLoadState("domcontentloaded");
    await expect(browser.locator("h1")).toHaveText("Store home");

    // The whole-list replay the trainer's ▶ runs, since that is what the user
    // watches succeed while the page sits somewhere they did not expect.
    //
    // NOTE WHAT THIS DOES AND DOES NOT SHOW, because the honest version is the
    // useful one: the trainer's replayer SKIPS `goto` steps ("goto runs at test
    // start; skipped in preview"), so a list whose only step is the initial
    // navigation issues no request at all and reports ok. That is precisely the
    // shape of the reported bug — a green step list over a page that never
    // moved — so the row asserts the replay changed nothing rather than
    // pretending it proved a navigation, and the signing claim rests on the
    // request log below.
    const beforeReplay = store.seen().length;
    const replay = await invoke<{ ok: boolean }>(window, "recorder:replayAll");
    expect(replay.ok).toBe(true);
    expect(store.seen().length, "a goto-only replay issues no request").toBe(beforeReplay);
    await expect(browser.locator("h1")).toHaveText("Store home");
    await stopRecording(window);

    const after = store.seen().slice(before);
    expect(after.length, "the reopened session really loaded the page").toBeGreaterThan(0);
    expect(
      after.filter((line) => line.endsWith("unsigned")),
      `requests after reopening:\n${after.join("\n")}`,
    ).toEqual([]);
  } finally {
    await stopRecording(window).catch(() => {});
    await store.close();
  }
});
