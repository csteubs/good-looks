// The proxy settings' rules: what the stored values may be, which traffic
// class a configuration covers, and how a manual proxy reaches a Playwright
// run's environment.
//
// Shared for the same reason as user-data-rules.mjs: TWO processes act on
// these settings. The app applies them to the training browser, to its own
// outbound requests and to the runs it spawns; the standalone MCP server
// spawns runs of the same tests from the same settings file. A transcribed
// copy of "when does a run get a proxy" is right the day it's written and
// silently divergent after — and the direction it fails is an MCP run going
// straight to the network while the identical app run goes through the proxy,
// which no output from either would ever mention.
//
// Pure only: no fs, no process, no Electron. The one secret — the proxy
// password — is NOT part of these settings. It lives encrypted in the app's
// safeStorage (proxy-password-store.ts) and is handed IN to the one function
// here that can use it, so this module never learns how to find it and the
// MCP server (which cannot decrypt it) passes null and says so in its run
// description.

/** Which traffic a proxy configuration covers. Mirrors the mabl Desktop App's
 *  vocabulary (mabl/test/both/none) with "app" for this app's own traffic. */
export const PROXY_TRAFFIC_VALUES = ["none", "app", "test", "both"];

/** Where the proxy configuration comes from: the OS, or the fields below it. */
export const PROXY_SOURCE_VALUES = ["automatic", "manual"];

/** Proxy URL schemes accepted by every consumer: Chromium (the training
 *  browser), Playwright, and the app's own requests (undici's ProxyAgent for
 *  http/https, its Socks5ProxyAgent for socks5). */
export const PROXY_URL_SCHEMES = ["http:", "https:", "socks5:"];

export const PROXY_DEFAULTS = {
  proxyTraffic: "none",
  proxySource: "automatic",
  proxyUrl: "",
  proxyUsername: "",
  proxySslVerify: true,
};

export function isProxyTraffic(v) {
  return PROXY_TRAFFIC_VALUES.includes(v);
}

export function isProxySource(v) {
  return PROXY_SOURCE_VALUES.includes(v);
}

/**
 * Validate and canonicalise a manual proxy URL.
 *
 * Returns `{ ok: true, url }` with `url` in `scheme://host[:port]` form, or
 * `{ ok: false, reason }` with a sentence fit for a settings row.
 *
 * Two rules beyond "does it parse":
 *  - The scheme allowlist above. `new URL` accepts anything ("ftp:", "gopher:")
 *    and every consumer downstream would either error opaquely or, worse,
 *    ignore the proxy and go direct — a wrong network path that looks exactly
 *    like a working one.
 *  - NO CREDENTIALS IN THE URL. The URL is stored in the plain-JSON settings
 *    file; the password field is encrypted precisely so it never is. Accepting
 *    `http://user:pass@host` here would quietly re-create the plaintext copy
 *    the split exists to prevent, so it is refused with directions rather
 *    than stripped — stripping would save a password somewhere the user
 *    didn't put it and lose it from where they did.
 */
export function normalizeProxyUrl(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return { ok: false, reason: "Enter a proxy URL." };
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "Not a valid URL — expected something like http://192.168.0.1:8080." };
  }
  if (!PROXY_URL_SCHEMES.includes(url.protocol)) {
    return { ok: false, reason: "The proxy URL must start with http://, https:// or socks5://." };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      reason: "Take the credentials out of the URL — use the Username and Password fields, which store the password encrypted.",
    };
  }
  if (!url.hostname) return { ok: false, reason: "The proxy URL needs a host." };
  if (url.pathname !== "/" && url.pathname !== "") {
    return { ok: false, reason: "A proxy URL is just scheme, host and port — drop the path." };
  }
  // Canonical form. `url.host` keeps an explicit port and drops a default one
  // (http://p:80 → p), which is fine: every consumer applies the same default.
  return { ok: true, url: `${url.protocol}//${url.host}` };
}

/**
 * The proxy-shaped subset of a settings object, rebuilt from unknown input.
 *
 * REBUILDS rather than filters, per the capture-boundary rule: this reads a
 * hand-editable JSON file on the app side and the same file from a separate
 * process on the MCP side, and both must land on the same answer for the same
 * bytes. A stored URL that fails validation comes back as "" — the proxy then
 * simply never applies, which is the recoverable outcome; guessing a
 * correction would send traffic somewhere the user didn't write.
 */
export function proxySettingsFrom(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const url = normalizeProxyUrl(r.proxyUrl);
  return {
    proxyTraffic: isProxyTraffic(r.proxyTraffic) ? r.proxyTraffic : PROXY_DEFAULTS.proxyTraffic,
    proxySource: isProxySource(r.proxySource) ? r.proxySource : PROXY_DEFAULTS.proxySource,
    proxyUrl: url.ok ? url.url : "",
    proxyUsername: typeof r.proxyUsername === "string" ? r.proxyUsername : "",
    proxySslVerify:
      typeof r.proxySslVerify === "boolean" ? r.proxySslVerify : PROXY_DEFAULTS.proxySslVerify,
  };
}

/**
 * Whether `kind` ("app" | "test") traffic is covered by the chosen traffic
 * setting. Only the selector — "covered" does not yet mean "has a proxy":
 * automatic mode covers a class by leaving it to the OS, and manual mode with
 * no valid URL covers it with nothing. Use `manualProxyFor` for "what should
 * this request actually do".
 */
export function proxyAppliesTo(settings, kind) {
  const traffic = settings?.proxyTraffic;
  if (traffic === "both") return true;
  return traffic === kind;
}

/**
 * The manual proxy to use for `kind` traffic, or null.
 *
 * Null means "change nothing": traffic set to none, the class not covered,
 * automatic mode (the OS decides), or manual mode with no usable URL. That
 * last case is deliberate — mabl's manual mode is "basic networking … along
 * with OPTIONALLY supplied proxy settings", so an empty URL is direct, not an
 * error.
 */
export function manualProxyFor(settings, kind) {
  if (!proxyAppliesTo(settings, kind)) return null;
  if (settings.proxySource !== "manual") return null;
  const url = normalizeProxyUrl(settings.proxyUrl);
  if (!url.ok) return null;
  return {
    url: url.url,
    username: settings.proxyUsername || "",
    sslVerify: settings.proxySslVerify !== false,
  };
}

/**
 * The environment a Playwright run needs to honour these settings, given the
 * decrypted proxy password (or null where it cannot be decrypted — the MCP
 * server). Empty in automatic mode on purpose: automatic means the browsers
 * detect the OS configuration themselves, which is what they do when the
 * config declares no proxy at all.
 *
 * PW_PROXY_PASSWORD only ever appears alongside PW_PROXY_USERNAME: a password
 * with no username is not a credential any proxy scheme can spend, and the
 * config file reads the pair as one.
 */
export function playwrightProxyEnv(settings, password) {
  const manual = manualProxyFor(settings, "test");
  if (!manual) return {};
  const env = { PW_PROXY_SERVER: manual.url };
  if (manual.username) {
    env.PW_PROXY_USERNAME = manual.username;
    if (typeof password === "string" && password.length > 0) {
      env.PW_PROXY_PASSWORD = password;
    }
  }
  if (!manual.sslVerify) env.PW_IGNORE_HTTPS_ERRORS = "1";
  return env;
}

/**
 * Hosts a proxy must never be asked to carry: the machine's own loopback.
 *
 * Chromium bypasses these implicitly, so the training browser and Playwright
 * get this rule for free — this function exists for the app's own requests,
 * where undici has no implicit rules and a manual proxy would otherwise be
 * handed the user's local Ollama or LM Studio and refuse or misroute it.
 */
export function isLoopbackHost(hostname) {
  const h = (hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (/^127(\.\d{1,3}){3}$/.test(h)) return true;
  return false;
}
