// What a Shopify crawler signature IS: how its three header values are spelled,
// what a pasted value has to look like to be accepted, which host it may be
// sent to, and when it has expired.
//
// Here rather than in `main/services/` because three processes need the same
// answers and they cannot share a `.ts`. The app is compiled and bundled; the
// renderer needs `signatureState` to label a settings row; the MCP server is
// plain `.mjs` with no build step and needs it to say why a run went unsigned.
// A transcribed copy would be right the day it was written — and what diverges
// is the rule deciding where a credential is sent.
//
// Pure: no `fs`, no shell import, no `process`, no clock. `now` is always passed
// in, which is also what lets the expiry tests pin a boundary without touching
// the system time.
//
// ── The mechanism ─────────────────────────────────────────────────────────
// A merchant generates a signature in the Shopify admin and copies out three
// static header values. There is no per-request crypto on this side: the same
// three values are sent on every request, and Shopify's edge verifies them.
// This is RFC 9421 HTTP Message Signatures in the web-bot-auth profile.
//
// Two consequences drive everything below.
//
//   • The signature covers `@authority`, which is a DERIVED component — the
//     host is never serialised into the header, so it cannot be read back out
//     of a pasted value. The user types it, and it is matched EXACTLY. Sending
//     a signature at a host it was not issued for does not merely fail to
//     help: it presents an invalid signature to a verifier whose entire job is
//     spotting bot spoofing. Silence is the better failure.
//
//   • It expires — three months at most, and Shopify does not renew. An
//     expired signature is worse than none for the same reason, so
//     `signatureForUrl` refuses one rather than leaving that decision to each
//     of the three call sites.

/** The three header names, lowercase, spelled once.
 *
 *  Read by the trainer's header injection, the run fixture, and the never-list
 *  that keeps them out of recorded artifacts. Three spellings of a header name
 *  means one of those three quietly stops matching. */
export const SIGNATURE_HEADER_NAMES = Object.freeze([
  "signature-input",
  "signature",
  "signature-agent",
]);

/** The literal value of `Signature-Agent`, quotes included.
 *
 *  The quotes are not decoration and must not be trimmed: the header is an RFC
 *  8941 structured-field String, whose serialisation IS the quoted form. A
 *  bare `https://shopify.com` is a different (invalid) field value. */
export const SIGNATURE_AGENT_VALUE = '"https://shopify.com"';

/** How long before expiry a signature starts being reported as expiring.
 *
 *  Two weeks out of a maximum three-month life. Long enough to act on before a
 *  scheduled run starts failing, short enough that the warning still means
 *  something when it appears. */
export const EXPIRY_WARN_DAYS = 14;

/** Longest header value accepted. A real `Signature-Input` runs to roughly 200
 *  characters; this is a bound, not a fit. */
export const MAX_HEADER_VALUE_LENGTH = 4096;

/** Upper bound on a parsed `created`/`expires`, as unix seconds: 2100-01-01.
 *
 *  Absolute rather than relative to now, so parsing stays pure and total. It
 *  does two jobs — it rejects a corrupt paste, and it keeps the value inside
 *  the range where `Number()` is exact, so a 30-digit run of ones cannot come
 *  back as a rounded float. Whether an expiry is implausibly FAR AWAY is a
 *  different question, answered against a clock in `signatureState`. */
const MAX_TIMESTAMP_SECONDS = 4102444800;

/**
 * Split an RFC 9421 field value into its top-level `;`-separated segments.
 *
 * The whole reason this is a scanner and not a `split(";")` — or, worse, a
 * `/expires=(\d+)/` — is that both of the delimiters that matter also occur
 * INSIDE the value. `keyid` is a quoted base64 string, and the covered-component
 * list is a parenthesised list of quoted strings:
 *
 *   sig1=("@authority");created=1;expires=2;keyid="…expires=999…";alg="ed25519"
 *
 * A regex reads the `expires=999` inside `keyid` as happily as the real one,
 * and which one it returns depends on where it happens to sit in the string.
 * That is an expiry date read out of attacker-adjacent base64.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function topLevelSegments(raw) {
  const out = [];
  let current = "";
  let inQuotes = false;
  let escaped = false;
  let depth = 0;
  for (const ch of raw) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (inQuotes) {
      current += ch;
      if (ch === "\\") escaped = true;
      else if (ch === '"') inQuotes = false;
      continue;
    }
    if (ch === '"') {
      current += ch;
      inQuotes = true;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  // An unterminated quote or paren means the value is malformed, not that the
  // tail should be guessed at.
  if (inQuotes || depth !== 0) return [];
  return out;
}

/**
 * A bare integer parameter value (RFC 8941 sf-integer), or null.
 *
 * Deliberately strict: digits only, no sign, no whitespace, no quotes, and
 * inside the plausible range. A quoted `"1735689600"` is a String, not an
 * Integer, and is not accepted as one.
 *
 * @param {string} raw
 * @returns {number | null}
 */
function integerValue(raw) {
  const text = raw.trim();
  if (!/^\d{1,12}$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMESTAMP_SECONDS) return null;
  return value;
}

/**
 * A quoted-string parameter value with its quotes stripped and escapes undone,
 * or null when it is not a quoted string.
 *
 * @param {string} raw
 * @returns {string | null}
 */
function stringValue(raw) {
  const text = raw.trim();
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return null;
  return text.slice(1, -1).replace(/\\(.)/g, "$1");
}

/**
 * Read the parameters out of a `Signature-Input` value.
 *
 * Returns null when the value is unparseable. Every field is independently
 * optional, because RFC 9421 makes them so: `expires` in particular is a
 * convention of the web-bot-auth profile rather than a requirement, and a
 * missing one must surface as "expiry unknown" rather than being invented. The
 * app has no basis for assuming ninety days from whenever the paste happened.
 *
 * @param {string} raw
 * @returns {{ createdAt: number | null, expiresAt: number | null,
 *             keyId: string | null, alg: string | null, tag: string | null } | null}
 */
export function parseSignatureInput(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const segments = topLevelSegments(raw);
  // The first segment is the label and its covered-component list; parameters
  // follow it. Nothing but parameters is read here — in particular the covered
  // component list is NOT parsed and NOT acted on. Where this app sends a
  // credential is its own contract, not something a pasted string may widen.
  if (segments.length < 1 || !segments[0].includes("=")) return null;

  const result = { createdAt: null, expiresAt: null, keyId: null, alg: null, tag: null };
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf("=");
    if (eq < 0) continue; // a bare parameter (boolean true); none we read
    const name = segment.slice(0, eq).trim().toLowerCase();
    const value = segment.slice(eq + 1);
    if (name === "created") result.createdAt = integerValue(value);
    else if (name === "expires") result.expiresAt = integerValue(value);
    else if (name === "keyid") result.keyId = stringValue(value);
    else if (name === "alg") result.alg = stringValue(value);
    else if (name === "tag") result.tag = stringValue(value);
  }
  return result;
}

/**
 * Why a pasted header value is unacceptable, or null when it is fine.
 *
 * This value is untrusted text that gets persisted and later concatenated into
 * an HTTP header — on the run side it travels to the browser as CDP JSON, which
 * is a far weaker guarantee than Chromium's own header parser. So it is checked
 * here, on the way in, in the same spirit as `normalizeRawStep`: printable
 * ASCII only, which rejects CR, LF and NUL and therefore header injection, plus
 * a length bound.
 *
 * Returns the reason rather than a boolean so the settings pane can say what
 * was wrong with a paste it refused.
 *
 * @param {string} raw
 * @param {string} label
 * @returns {string | null}
 */
export function headerValueProblem(raw, label = "value") {
  if (typeof raw !== "string" || raw.trim() === "") return `The ${label} is empty.`;
  const text = raw.trim();
  if (text.length > MAX_HEADER_VALUE_LENGTH) {
    return `The ${label} is longer than ${MAX_HEADER_VALUE_LENGTH} characters.`;
  }
  // eslint-disable-next-line no-control-regex -- the control characters ARE the check
  if (/[^\x20-\x7E]/.test(text)) {
    return `The ${label} contains a line break or a character that can't appear in an HTTP header.`;
  }
  return null;
}

/**
 * The trimmed header value, or null when it is unacceptable.
 *
 * @param {string} raw
 * @returns {string | null}
 */
export function validateHeaderValue(raw) {
  if (headerValueProblem(raw) !== null) return null;
  return raw.trim();
}

/**
 * The host a signature is bound to, normalised, or null.
 *
 * Accepts what a user would plausibly paste — a full storefront URL, or a bare
 * host — and reduces both to `URL.host`, which lowercases, applies IDNA, and
 * KEEPS a non-default port (two origins differing only by port are two
 * authorities, and the signature covers the authority).
 *
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizeSignatureHost(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text === "" || /[\s*]/.test(text)) return null;
  // A scheme is only a scheme when `//` follows it. Testing for a bare colon
  // instead would read `shop.example.com:8443` as the scheme
  // `shop.example.com`, and a port is part of the authority a signature covers.
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(text);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    // Rejected outright rather than re-prefixed: `https://` + `ftp://x.com`
    // parses cleanly and yields the host `ftp`, which is a plausible-looking
    // answer to a question that should have had none.
    if (name !== "http" && name !== "https") return null;
  }
  let parsed;
  try {
    parsed = scheme ? new URL(text) : new URL(`https://${text}`);
  } catch {
    return null;
  }
  const host = parsed.host.toLowerCase();
  return host === "" ? null : host;
}

/**
 * How much life a signature has left.
 *
 * `expiresAt` is unix SECONDS, exactly as the header carries it. `nowMs` is
 * milliseconds, exactly as `Date.now()` gives it. The two units are deliberate
 * and named: converting at the parse boundary would make the parse result stop
 * saying what the header says.
 *
 * @param {{ expiresAt: number | null | undefined, nowMs: number }} input
 * @returns {"valid" | "expiring" | "expired" | "unknown"}
 */
export function signatureState({ expiresAt, nowMs }) {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return "unknown";
  const remainingMs = expiresAt * 1000 - nowMs;
  if (remainingMs <= 0) return "expired";
  if (remainingMs <= EXPIRY_WARN_DAYS * 24 * 60 * 60 * 1000) return "expiring";
  return "valid";
}

/**
 * The signature to send with a request to `url`, or null.
 *
 * Exact host match, and no subdomain or apex fallback: `www.example.com` and
 * `example.com` are different authorities and need separate signatures, as do a
 * custom domain and its `*.myshopify.com` counterpart. A storefront's own CDN
 * (`cdn.shopify.com`) is a different authority again and is never signed —
 * which is the property that keeps this credential off every third-party host a
 * storefront loads from.
 *
 * An expired entry returns null HERE rather than at each call site, so the
 * trainer, the runner and the fixture cannot disagree about it.
 *
 * @template {{ host: string, expiresAt?: number | null }} T
 * @param {readonly T[]} entries
 * @param {string} url
 * @param {number} nowMs
 * @returns {T | null}
 */
export function signatureForUrl(entries, url, nowMs) {
  const host = normalizeSignatureHost(url);
  if (!host || !Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (!entry || entry.host !== host) continue;
    if (signatureState({ expiresAt: entry.expiresAt, nowMs }) === "expired") return null;
    return entry;
  }
  return null;
}
