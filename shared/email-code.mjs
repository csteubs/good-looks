// What "sign in with the code they emailed you" IS: where the mailbox lives,
// which message may be believed, and how six digits are found inside it.
//
// Here rather than in `main/services/` because three processes need identical
// answers and cannot share a `.ts`. The trainer resolves a code so the user can
// replay a login step; the generated runtime resolves one so the RUN can type
// it; the renderer labels the step and the Settings row. A transcribed copy
// would be right the day it was written, and what diverges is the rule that
// decides whether a code is stale — which fails silently, as a plausible six
// digits that Shopify rejects.
//
// Pure per CLAUDE.md: no `fs`, no shell import, no `process`, no DOM, no clock.
// Every time comes in as a parameter, which is also what lets the watermark
// tests pin a boundary without touching the system clock.
//
// ── Why this exists at all ────────────────────────────────────────────────
// Shopify's new customer accounts have no password. Classic accounts were
// deprecated in Feb 2026, Multipass is not supported on the new ones, and the
// Customer Account API's every flow begins at Shopify's hosted login — the same
// emailed-code screen. There is no test mode and no admin bypass. The code has
// to be read out of a mailbox. See docs/plans/shopify-account-auth.md.
//
// ── The rule that carries the feature ─────────────────────────────────────
// A code is valid for about thirty minutes, and five rejected codes locks the
// customer out for thirty more. So the failure that matters is not "no code
// arrived" — that one is loud. It is typing a code that was ALREADY in the
// inbox, from the previous run or from earlier in the same suite: a plausible
// six digits, rejected, and five of those costs the suite half an hour.
//
// Hence the watermark. A message is only a candidate when it arrived after the
// later of "this run started" and "the last code this run consumed", and both
// halves are needed: the first stops a code minted before the run existed, the
// second stops a spec that signs in twice from reusing the first one.

/** Poll interval. Shopify's code lands in seconds; a tighter loop only spends
 *  the mailbox endpoint's budget faster without arriving any sooner. */
export const POLL_INTERVAL_MS = 2000;

/** Total time a code step waits before failing. Generous against mail delay,
 *  bounded so a login that will never receive a code fails as itself —
 *  "no code arrived in 60s at <address>" — rather than as a Playwright
 *  timeout on the fill that comes after it, which names nothing. */
export const POLL_BUDGET_MS = 60_000;

/** Digits in a Shopify customer-account code. Configurable per step because
 *  nothing here is Shopify-specific except the default. */
export const DEFAULT_CODE_DIGITS = 6;

/** Bounds on a stored mailbox endpoint and token. Bounds, not fits. */
export const MAX_ENDPOINT_LENGTH = 2048;
export const MAX_TOKEN_LENGTH = 512;
export const MAX_ADDRESS_LENGTH = 320;

/** Longest message excerpt the code scan will look at. The endpoint caps what
 *  it stores; this caps what a caller will scan regardless, so a Worker that
 *  is changed to return whole messages cannot turn every poll into a scan of
 *  an arbitrarily long body. */
export const MAX_BODY_SCAN = 8192;

/**
 * Why this endpoint may not be used, or null when it may.
 *
 * A problem STRING rather than a boolean, for the same reason
 * `headerValueProblem` returns one: this is shown in Settings, and "that is
 * not a URL" and "that is not https" send the user to different fixes.
 *
 * HTTPS only, with `http://localhost` (and 127.0.0.1) allowed because that is
 * how the Worker is exercised with `wrangler dev` before it is deployed. A
 * bearer token travels on every request to this address; over plain http to
 * anywhere else it travels in clear text.
 *
 * Embedded credentials are refused outright. A URL carrying `user:pass@` puts
 * a second secret somewhere nothing redacts, and it would be sent to whatever
 * host follows the `@` — which is not necessarily the host the user read.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function endpointProblem(value) {
  if (typeof value !== "string" || value.trim() === "") return "Enter the mailbox endpoint URL.";
  const raw = value.trim();
  if (raw.length > MAX_ENDPOINT_LENGTH) return "That URL is too long.";
  // Printable ASCII only. The value is concatenated into a request; anything
  // outside this range is either a paste artifact or an injection attempt.
  if (!/^[\x20-\x7e]+$/.test(raw)) return "That URL contains characters a URL cannot carry.";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "That is not a URL. Paste the full address, including https://.";
  }
  if (url.username !== "" || url.password !== "") {
    return "Remove the username and password from the URL — the token is stored separately.";
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "http:" && local) return null;
  if (url.protocol !== "https:") {
    return "Use https — the mailbox token is sent on every request to this address.";
  }
  return null;
}

/**
 * Why this token may not be used, or null when it may.
 *
 * The value becomes an `Authorization` header, so the printable-ASCII rule is
 * the same header-injection guard `shared/shopify-signature.mjs` applies: a CR
 * or LF in a header value is a second header, and the request travels to
 * Playwright as CDP JSON rather than through Chromium's own parser.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function tokenProblem(value) {
  if (typeof value !== "string" || value === "") return "Enter the mailbox token.";
  if (value.length > MAX_TOKEN_LENGTH) return "That token is too long.";
  if (!/^[\x20-\x7e]+$/.test(value)) {
    return "That token contains characters a header cannot carry — check the paste.";
  }
  if (value !== value.trim()) return "That token has whitespace around it.";
  return null;
}

/**
 * Why this address may not be used, or null when it may.
 *
 * Deliberately permissive about the local part — real mailboxes carry `+`, `.`
 * and more, and a validator that is stricter than the mail system refuses
 * addresses that work. What it does enforce is the part that matters here: one
 * `@`, a dotted host after it, nothing outside printable ASCII, and a length
 * bound. The address is put into a query string and into an error message.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function addressProblem(value) {
  if (typeof value !== "string" || value.trim() === "") return "Enter the mailbox address.";
  const raw = value.trim();
  if (raw.length > MAX_ADDRESS_LENGTH) return "That address is too long.";
  if (!/^[\x21-\x7e]+$/.test(raw)) return "That address contains characters an address cannot carry.";
  const at = raw.indexOf("@");
  if (at <= 0 || at !== raw.lastIndexOf("@")) return "That is not an email address.";
  const host = raw.slice(at + 1);
  if (!/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(host)) return "That address has no valid domain.";
  return null;
}

/**
 * The stored spelling of an address: trimmed and lower-cased.
 *
 * Lower-cased whole, local part included. That is technically more than RFC
 * 5321 allows — a local part is case-SENSITIVE to the letter of the spec — and
 * it is right anyway: Shopify lower-cases customer emails, the Worker keys its
 * KV entries by this same function, and the failure of disagreeing here is a
 * poll that matches nothing while the mail sits in the store.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeAddress(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * The URL a poll actually requests.
 *
 * Built with `URL`/`searchParams` rather than concatenation because the address
 * is user data going into a query string, and `+` — which is IN the address of
 * every sub-addressed mailbox — means a space when a query string is parsed.
 * Hand-concatenated, `a+b@x.com` reaches the Worker as `a b@x.com` and matches
 * nothing.
 *
 * @param {string} endpoint
 * @param {string} address
 * @param {number} sinceMs  only messages received after this instant
 * @returns {string}
 */
export function messagesUrl(endpoint, address, sinceMs) {
  const url = new URL(String(endpoint));
  url.searchParams.set("address", normalizeAddress(address));
  url.searchParams.set("since", String(Math.floor(Number(sinceMs) || 0)));
  return url.toString();
}

/**
 * The instant a message must beat to be believed.
 *
 * The later of "this run started" and "the last code this run consumed". Both
 * halves carry their own failure: without the first, a code minted before the
 * run existed is typed and rejected; without the second, a spec that signs in
 * twice types the first code again.
 *
 * SELF-CONTAINED — embedded into the generated runtime via `toString()`, the
 * step-semantics idiom. No free identifiers beyond its parameters.
 *
 * @param {number} runStartedAt
 * @param {number} lastConsumedAt
 * @returns {number}
 */
export function codeWatermark(runStartedAt, lastConsumedAt) {
  const a = Number(runStartedAt) || 0;
  const b = Number(lastConsumedAt) || 0;
  return a > b ? a : b;
}

/**
 * The code inside one message, or null when it holds none.
 *
 * SELF-CONTAINED — embedded into the generated runtime via `toString()`, so
 * the trainer's preview and the run's fill can never disagree about which six
 * digits the message meant. No free identifiers beyond its parameters.
 *
 * Three rules, each against a specific way of reading the wrong number:
 *
 *   • The SUBJECT is searched before the body. Shopify puts the code there
 *     ("123456 is your login code"), and a subject holds one number where a
 *     body holds an order number, a year, a street number and a tracking id.
 *
 *   • A run of exactly `digits` digits, bounded by non-digits. Without the
 *     bound, a scan for six digits finds the first six of an eight-digit order
 *     number and returns a code that was never sent.
 *
 *   • An optional `label` — plain text, not a pattern — restricts the scan to
 *     what follows it. For a store whose template puts the code somewhere a
 *     bare scan gets wrong. Plain text and not a regex on purpose: this value
 *     comes from settings, and a regex from settings is a regex someone has to
 *     get right against a body this function will happily scan 8KB of.
 *
 * @param {{subject?: string, body?: string}} message
 * @param {{digits?: number, label?: string}} [opts]
 * @returns {string | null}
 */
export function codeFromMessage(message, opts) {
  const o = opts || {};
  const digits = Number(o.digits) > 0 ? Math.floor(Number(o.digits)) : 6;
  const label = typeof o.label === "string" ? o.label.trim() : "";
  const scan = (text) => {
    if (typeof text !== "string" || text === "") return null;
    let hay = text.length > 8192 ? text.slice(0, 8192) : text;
    if (label !== "") {
      const at = hay.toLowerCase().indexOf(label.toLowerCase());
      if (at < 0) return null;
      hay = hay.slice(at + label.length);
    }
    // Bounded on both sides by a non-digit, so a longer run never yields its
    // prefix. Built here rather than held as a module constant because this
    // function is embedded as source and must not reference anything outside
    // itself.
    const re = new RegExp("(?:^|[^0-9])([0-9]{" + digits + "})(?![0-9])", "g");
    const m = re.exec(hay);
    return m ? m[1] : null;
  };
  return scan(message && message.subject) || scan(message && message.body) || null;
}

/**
 * The newest message that beats the watermark and holds a code.
 *
 * Newest rather than oldest: when two codes are in flight the later one is the
 * one Shopify's screen is waiting for, and the earlier is already spent.
 *
 * @param {Array<{subject?: string, body?: string, receivedAt?: number}>} messages
 * @param {number} watermark
 * @param {{digits?: number, label?: string}} [opts]
 * @returns {{code: string, receivedAt: number} | null}
 */
export function pickCode(messages, watermark, opts) {
  if (!Array.isArray(messages)) return null;
  const after = Number(watermark) || 0;
  const fresh = messages
    .filter((m) => m && Number(m.receivedAt) > after)
    .sort((a, b) => Number(b.receivedAt) - Number(a.receivedAt));
  for (const m of fresh) {
    const code = codeFromMessage(m, opts);
    if (code) return { code, receivedAt: Number(m.receivedAt) };
  }
  return null;
}

// ── Reading the message the mailbox actually received ─────────────────────
//
// The parsing below runs in the CLOUDFLARE WORKER, not in the app — the app
// only ever sees the JSON the Worker returns. It lives here anyway, and the
// reason is the same "one spelling" argument the rest of this module rests on:
// `codeFromMessage` scans `subject` and then `body`, and this decides what
// `subject` and `body` ARE. Two halves of one rule. A Worker that stripped
// HTML differently, or left a subject RFC 2047-encoded, would hand back a
// message the scan above cannot find a code in — and the symptom is a login
// step that times out against a mailbox holding the code all along.
//
// It is also the only way this code gets TESTED: `workers/` matches neither
// vitest project, so a test file beside the Worker would be silently never
// run (CLAUDE.md, Testing).

/** Decode one RFC 2047 encoded-word run. Subjects arrive as
 *  `=?UTF-8?B?…?=` or `=?UTF-8?Q?…?=` from plenty of senders, and a subject
 *  left encoded defeats the subject-first scan entirely — which is the scan
 *  that exists because a subject holds one number and a body holds five. */
function decodeWords(value) {
  if (typeof value !== "string" || !value.includes("=?")) return value || "";
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset, enc, text) => {
    try {
      const bytes =
        enc.toUpperCase() === "B"
          ? base64Bytes(text)
          : qpBytes(text.replace(/_/g, " "));
      return bytes ? new TextDecoder(charsetOrUtf8(charset)).decode(bytes) : whole;
    } catch {
      // A charset we cannot decode is better left as written than replaced
      // with mojibake — the raw form is at least recognisable as encoded.
      return whole;
    }
  });
}

/** TextDecoder rejects an unknown label by throwing; anything we do not
 *  recognise is far likelier to be UTF-8 than to be undecodable. */
function charsetOrUtf8(charset) {
  const c = String(charset || "").toLowerCase();
  return c === "" || c === "unknown-8bit" ? "utf-8" : c;
}

function base64Bytes(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/=]/g, "");
  if (clean === "") return null;
  const bin = atob(clean);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

/** Quoted-printable to bytes. Soft line breaks (`=` at end of line) vanish;
 *  `=XX` becomes one byte. Byte-wise rather than character-wise because a
 *  multi-byte UTF-8 character arrives as several `=XX` and decoding each to a
 *  character separately produces two mojibake characters, not one real one. */
function qpBytes(text) {
  const src = String(text).replace(/=\r?\n/g, "");
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "=" && i + 2 < src.length && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      out.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Headers as a lowercased map, unfolded. First wins: a message carrying two
 *  Subject headers is either malformed or crafted, and the first is the one a
 *  mail client shows. */
function parseHeaders(block) {
  const out = {};
  const unfolded = block.replace(/\n[ \t]+/g, " ");
  for (const line of unfolded.split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    if (key in out) continue;
    out[key] = line.slice(at + 1).trim();
  }
  return out;
}

function decodePart(body, headers) {
  const enc = String(headers["content-transfer-encoding"] || "").toLowerCase().trim();
  const charset = /charset="?([^";\s]+)"?/i.exec(headers["content-type"] || "");
  const label = charsetOrUtf8(charset ? charset[1] : "utf-8");
  try {
    if (enc === "base64") return new TextDecoder(label).decode(base64Bytes(body) || new Uint8Array());
    if (enc === "quoted-printable") return new TextDecoder(label).decode(qpBytes(body));
  } catch {
    return body;
  }
  return body;
}

/** Tags out, entities that matter in, whitespace collapsed.
 *
 *  `<script>`/`<style>` contents are dropped first rather than de-tagged: a
 *  tracking script full of ids is exactly the kind of digit soup the
 *  boundary rule in `codeFromMessage` exists to survive, and not feeding it
 *  in is cheaper than surviving it. */
function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * One raw RFC 5322 message reduced to what finding a code needs.
 *
 * Deliberately NOT a general MIME parser and deliberately not storing the
 * whole message: this feeds a fixture endpoint, and a full-message store
 * behind a bearer token is a liability nobody asked for. Nested multiparts
 * are walked one level, which is what `multipart/alternative` inside
 * `multipart/mixed` needs and is where real login mail stops.
 *
 * text/plain wins over text/html when both are offered — same content, none
 * of the markup, and no digits from a tracking pixel's query string.
 *
 * @param {string} raw   the full message as received
 * @param {number} [limit] cap on the returned body
 * @returns {{subject: string, from: string, to: string, body: string}}
 */
export function parseMailMessage(raw, limit) {
  const cap = Number(limit) > 0 ? Math.floor(Number(limit)) : MAX_BODY_SCAN;
  const text = String(raw == null ? "" : raw).replace(/\r\n/g, "\n");
  const split = text.indexOf("\n\n");
  const headerBlock = split < 0 ? text : text.slice(0, split);
  const bodyBlock = split < 0 ? "" : text.slice(split + 2);
  const headers = parseHeaders(headerBlock);

  const pickBody = (body, hdrs, depth) => {
    const ctype = String(hdrs["content-type"] || "text/plain").toLowerCase();
    const boundary = /boundary="?([^";\s]+)"?/i.exec(hdrs["content-type"] || "");
    if (ctype.startsWith("multipart/") && boundary && depth < 2) {
      const parts = body.split("--" + boundary[1]);
      const decoded = [];
      for (const part of parts) {
        const trimmed = part.replace(/^\n/, "");
        if (trimmed === "" || trimmed.startsWith("--")) continue;
        const at = trimmed.indexOf("\n\n");
        if (at < 0) continue;
        const partHeaders = parseHeaders(trimmed.slice(0, at));
        decoded.push({
          type: String(partHeaders["content-type"] || "text/plain").toLowerCase(),
          text: pickBody(trimmed.slice(at + 2), partHeaders, depth + 1),
        });
      }
      const plain = decoded.find((p) => p.type.startsWith("text/plain"));
      if (plain) return plain.text;
      const html = decoded.find((p) => p.type.startsWith("text/html"));
      if (html) return html.text;
      return decoded.length > 0 ? decoded[0].text : "";
    }
    const body2 = decodePart(body, hdrs);
    return ctype.startsWith("text/html") ? htmlToText(body2) : body2;
  };

  const body = pickBody(bodyBlock, headers, 0);
  return {
    subject: decodeWords(headers.subject || "").slice(0, 998),
    from: decodeWords(headers.from || "").slice(0, 320),
    to: decodeWords(headers.to || "").slice(0, 320),
    body: body.length > cap ? body.slice(0, cap) : body,
  };
}
