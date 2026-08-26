// The catch-all mailbox behind the `emailCode` step.
//
// Cloudflare Email Routing delivers every message addressed to the configured
// domain here; `email()` reduces each one to what finding a code needs and
// parks it in KV for an hour. `fetch()` answers one authenticated question:
// "what has arrived for this address since this instant?"
//
// Deployed separately from the app (see README.md). It is in this repo, rather
// than only in a Cloudflare dashboard, for the same reason
// `scripts/switch-branch.mjs` runs standalone: a mechanism reachable only
// through a button is one nobody can debug.
//
// ── What it deliberately is not ───────────────────────────────────────────
// Not a mail archive. It stores the subject, a capped body excerpt, the
// envelope addresses and the receipt time — not the raw message — and every
// entry expires in an hour. A code is dead in thirty minutes, so nothing here
// needs to outlive that, and a full-message store sitting behind one bearer
// token is a liability nobody asked for.
//
// Not a general mail parser either: `parseMailMessage` lives in
// shared/email-code.mjs beside the code scan that consumes its output, so the
// two cannot disagree about what a body is. See that file's header.

import {
  MAX_BODY_SCAN,
  addressProblem,
  normalizeAddress,
  parseMailMessage,
} from "../../../shared/email-code.mjs";

/** How long a stored message lives. Cloudflare's floor is 60s; an hour is
 *  twice the life of the code it carries, so a poll can never miss one and
 *  nothing accumulates. */
const TTL_SECONDS = 3600;

/** Largest raw message read. A code email is a few KB; anything past this is
 *  someone else's problem and reading it would be this Worker's. */
const MAX_RAW_BYTES = 256 * 1024;

/** Most stored messages one poll will fetch bodies for. The `since` filter
 *  runs on the KEY, so this bounds work, not correctness. */
const MAX_FETCH = 10;

/** Timestamps are part of the KV key so `list()` returns them in order and a
 *  `since` filter needs no reads at all. Zero-padded because KV sorts keys as
 *  strings, and "9999999999999" sorts after "10000000000000" without it. */
function stamp(ms) {
  return String(ms).padStart(14, "0");
}

function keyPrefix(address) {
  return "msg:" + normalizeAddress(address) + ":";
}

/** Compare in constant time. The token is a shared secret and this endpoint
 *  will happily answer as fast as it is asked; a byte-at-a-time early return
 *  is a guessing oracle. The length difference still leaks, which is the
 *  standard trade and not worth a hash to close. */
function tokenMatches(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string") return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // This endpoint is read by a Playwright worker, never by a browser page.
      // Saying so keeps a stray script on some other origin from reading it.
      "cache-control": "no-store",
    },
  });
}

export default {
  /**
   * Email Routing hands every message for the domain to this.
   *
   * Never throws: a rejected `email()` handler makes Cloudflare BOUNCE the
   * message, and a bounced login code is indistinguishable, from the test's
   * side, from one that was never sent.
   */
  async email(message, env) {
    try {
      if (!env.MAILBOX) return;
      if (typeof message.rawSize === "number" && message.rawSize > MAX_RAW_BYTES) return;
      const raw = await new Response(message.raw).text();
      const parsed = parseMailMessage(raw, MAX_BODY_SCAN);
      const receivedAt = Date.now();
      // The ENVELOPE recipient, not the To: header. A catch-all receives mail
      // whose To: names something else entirely (a Bcc, a mailing list), and
      // the address the test polls for is the one Shopify delivered to.
      const to = normalizeAddress(message.to || parsed.to);
      if (!to) return;
      const record = {
        to,
        from: parsed.from || String(message.from || ""),
        subject: parsed.subject,
        body: parsed.body,
        receivedAt,
      };
      await env.MAILBOX.put(
        keyPrefix(to) + stamp(receivedAt) + ":" + crypto.randomUUID(),
        JSON.stringify(record),
        { expirationTtl: TTL_SECONDS, metadata: { receivedAt } },
      );
    } catch {
      // Swallowed on purpose, per the bounce note above.
    }
  },

  async fetch(request, env) {
    const expected = env.MAILBOX_TOKEN;
    // Fail CLOSED. A deploy that forgot the secret would otherwise be an
    // unauthenticated mailbox endpoint, and it would work perfectly.
    if (typeof expected !== "string" || expected === "") {
      return json({ error: "MAILBOX_TOKEN is not configured on this Worker." }, 503);
    }
    if (request.method !== "GET") return json({ error: "Use GET." }, 405);

    const auth = request.headers.get("authorization") || "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!tokenMatches(given, expected)) return json({ error: "Unauthorized." }, 401);

    const url = new URL(request.url);
    if (!url.pathname.endsWith("/messages")) return json({ error: "Not found." }, 404);

    const address = url.searchParams.get("address") || "";
    const problem = addressProblem(address);
    if (problem) return json({ error: problem }, 400);
    const since = Number(url.searchParams.get("since")) || 0;

    if (!env.MAILBOX) return json({ error: "No KV namespace bound." }, 503);

    const listed = await env.MAILBOX.list({ prefix: keyPrefix(address) });
    const fresh = listed.keys
      .filter((k) => {
        const at = k.metadata && Number(k.metadata.receivedAt);
        // Prefer the metadata, fall back to the key. Either way the filter
        // runs without reading a value.
        const stamped = Number.isFinite(at) ? at : Number(k.name.split(":")[2]);
        return Number.isFinite(stamped) && stamped > since;
      })
      .slice(-MAX_FETCH);

    const messages = [];
    for (const key of fresh) {
      const value = await env.MAILBOX.get(key.name, "json");
      if (value) messages.push(value);
    }
    return json({ messages });
  },
};
