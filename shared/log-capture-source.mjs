// Console + network capture helpers, as a raw JS string interpolated into the
// capture fixture (capture-fixture-source.ts).
//
// WHY A STRING. The fixture runs inside Playwright's own node process, loaded
// from a `.mjs` written next to the specs — it cannot import this project's
// modules. Anything that must run at capture time therefore has to be inlined.
// This mirrors DOM_HELPERS in capture-script.ts, which exists for the same
// reason, and the same rule applies: the tests evaluate THIS string, so what is
// verified is exactly what ships.
//
// WHY FILTER AT WRITE TIME. Header and URL scrubbing is structural — it depends
// only on the shape of the data, not on the user's configured secrets — so it
// can and must happen here, before anything reaches disk. Secret redaction
// (redactWithSnapshot) needs the main process's snapshot and cannot run in this
// child, so it is applied when the artifacts are READ. The two are
// complementary: this stops whole CLASSES of credential (Authorization,
// Cookie, ?token=) from ever being written; read-time redaction catches the
// specific values the user has told the app about.

import { SIGNATURE_HEADER_NAMES } from "./shopify-signature.mjs";

/** Response/request headers worth keeping, lowercase.
 *
 *  An ALLOWLIST, not a denylist. The user asked for headers to debug CORS and
 *  caching, which is a small, nameable set — while the space of headers that
 *  carry credentials is open-ended and grows with every API a page talks to. A
 *  denylist leaks the entry nobody thought of; this fails closed instead.
 *  Headers not on the list are still REPORTED BY NAME with their value elided,
 *  so a missing header is visible rather than invisible. */
export const HEADER_ALLOWLIST = [
  // Content shape
  "content-type",
  "content-length",
  "content-encoding",
  "content-disposition",
  "accept",
  "accept-encoding",
  // Caching
  "cache-control",
  "etag",
  "expires",
  "age",
  "last-modified",
  "if-none-match",
  "if-modified-since",
  "vary",
  // CORS
  "origin",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
  // Routing / diagnostics
  "location",
  "retry-after",
  "server",
  "user-agent",
  "x-requested-with",
  "x-request-id",
  "x-correlation-id",
  "x-trace-id",
];

/** Headers whose values are elided even when the user has asked for all of
 *  them, because THIS APP put them there.
 *
 *  `recordAllHeaders` is documented as a deliberate opt-out for headers *the
 *  page* sends: the user is choosing to record their own traffic, credentials
 *  and all, into their own artifact. These three are different in kind — they
 *  are a credential the app injected on the user's behalf, and the artifact
 *  they land in is read back into the Visual tab and fed to a hosted LLM by
 *  Debug with AI. An app recording its own injected credential is not something
 *  the user opted into by asking to see the page's headers.
 *
 *  That is also why the line stops here and does not grow to cover
 *  `authorization` and `cookie`: those the escape hatch is FOR.
 *
 *  Spelled in shared/shopify-signature.mjs so the injector and the filter
 *  cannot disagree about a header name. */
export const HEADER_NEVER_RECORD = [...SIGNATURE_HEADER_NAMES];

/** Query parameters whose VALUES are masked in recorded URLs.
 *
 *  Unlike headers this is a denylist, and deliberately so: a URL's path is the
 *  single most useful thing about a request, and allowlisting parameter names
 *  would blank out the ordinary ones (`page`, `q`, `id`) that make a log
 *  readable. The names below are the ones that carry credentials in practice. */
export const SENSITIVE_QUERY_PARAMS = [
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "key",
  "api_key",
  "apikey",
  "secret",
  "client_secret",
  "password",
  "passwd",
  "pwd",
  "auth",
  "authorization",
  "session",
  "sessionid",
  "sid",
  "sig",
  "signature",
  "code",
  "jwt",
];

/** Per-run caps. A page that logs in a loop, or polls, can otherwise produce a
 *  file far larger than every screenshot combined. Head + tail is kept rather
 *  than a plain tail: the opening of a run (page load, first requests) is
 *  usually as diagnostic as the end. */
export const MAX_CONSOLE_HEAD = 100;
export const MAX_CONSOLE_TAIL = 400;
export const MAX_NETWORK_HEAD = 100;
export const MAX_NETWORK_TAIL = 400;
/** Longest single console message kept. A serialized object or stack trace can
 *  run to megabytes on its own. */
export const MAX_TEXT_CHARS = 2000;

export const ELIDED = "<omitted>";

/** The helper functions, as JS source. Interpolated into the fixture AND
 *  evaluated directly by log-capture.check.ts. */
export const LOG_CAPTURE_HELPERS = `
const GLAZE_HEADER_ALLOWLIST = ${JSON.stringify(HEADER_ALLOWLIST)};
const GLAZE_HEADER_NEVER = ${JSON.stringify(HEADER_NEVER_RECORD)};
const GLAZE_SENSITIVE_PARAMS = ${JSON.stringify(SENSITIVE_QUERY_PARAMS)};
const GLAZE_ELIDED = ${JSON.stringify(ELIDED)};
const GLAZE_MAX_TEXT = ${MAX_TEXT_CHARS};

/** Keep allowlisted headers; report the rest by name with the value elided, so
 *  "this request carried an Authorization header" stays visible while its value
 *  never reaches disk. allowAll is the user's explicit escape hatch. */
function glazeFilterHeaders(headers, allowAll) {
  const out = {};
  if (!headers || typeof headers !== "object") return out;
  for (const rawName of Object.keys(headers)) {
    const name = String(rawName).toLowerCase();
    // BEFORE the allowAll branch, not after. The never-list is the one rule
    // the escape hatch does not override, and moving this test to the far side
    // of that || is a one-token change that is completely silent.
    if (GLAZE_HEADER_NEVER.indexOf(name) >= 0) {
      out[name] = GLAZE_ELIDED;
    } else if (allowAll || GLAZE_HEADER_ALLOWLIST.indexOf(name) >= 0) {
      out[name] = glazeTruncate(String(headers[rawName]));
    } else {
      out[name] = GLAZE_ELIDED;
    }
  }
  return out;
}

/** Mask the values of credential-bearing query parameters, keeping the rest of
 *  the URL intact. A URL that cannot be parsed is returned with its query
 *  dropped entirely rather than guessed at. */
function glazeScrubUrl(url) {
  const raw = String(url == null ? "" : url);
  const q = raw.indexOf("?");
  if (q < 0) return glazeTruncate(raw);
  const base = raw.slice(0, q);
  const hashAt = raw.indexOf("#", q);
  const queryPart = hashAt >= 0 ? raw.slice(q + 1, hashAt) : raw.slice(q + 1);
  const hash = hashAt >= 0 ? raw.slice(hashAt) : "";
  const pairs = queryPart.split("&");
  const kept = [];
  for (const pair of pairs) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const name = eq < 0 ? pair : pair.slice(0, eq);
    const decoded = (function () {
      try { return decodeURIComponent(name).toLowerCase(); } catch (e) { return name.toLowerCase(); }
    })();
    if (eq >= 0 && GLAZE_SENSITIVE_PARAMS.indexOf(decoded) >= 0) {
      kept.push(name + "=" + GLAZE_ELIDED);
    } else {
      kept.push(pair);
    }
  }
  return glazeTruncate(base + (kept.length ? "?" + kept.join("&") : "") + hash);
}

function glazeTruncate(text) {
  const s = String(text == null ? "" : text);
  return s.length > GLAZE_MAX_TEXT ? s.slice(0, GLAZE_MAX_TEXT) + "…" : s;
}

/** Head+tail bounded collector. Returns { head, tail, dropped }. */
function glazeMakeStore() {
  return { head: [], tail: [], dropped: 0 };
}

function glazePush(store, entry, headMax, tailMax) {
  if (store.head.length < headMax) {
    store.head.push(entry);
    return;
  }
  store.tail.push(entry);
  if (store.tail.length > tailMax) {
    store.tail.shift();
    store.dropped++;
  }
}

function glazeDrain(store) {
  return { entries: store.head.concat(store.tail), dropped: store.dropped };
}
`;
