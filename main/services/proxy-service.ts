// Applies the Settings → Proxy configuration to every place this app touches
// the network, and validates it on demand. One service because the settings
// are one object: the decision "does THIS request use the proxy" must come out
// the same for a Chromium session, an undici dispatcher and a Playwright run,
// and three local copies of that rule is how one of them stops agreeing.
//
// The three traffic surfaces, and what applying the settings means on each:
//
//  • The app's own Node-side requests (AI providers, GitHub, webhooks) go
//    through `appFetch` below — plain global fetch when the answer is
//    "direct", an undici ProxyAgent/Socks5ProxyAgent when it isn't. Automatic
//    mode asks Electron's session resolver per URL, which is the OS
//    configuration, PAC files included. Loopback NEVER proxies: a manual
//    proxy handed the user's local Ollama would refuse or misroute it, and
//    undici has none of Chromium's implicit bypass rules.
//
//  • Chromium sessions — the training browser's per-recording partition and
//    the default session (which carries the renderer's site-icon fetches) —
//    get `setProxy` + a certificate proc via `applySessionProxy`. Automatic
//    mode is `mode: "system"`, which is Chromium's default restated so a
//    switch back from manual actually lands.
//
//  • Test runs get their configuration as PW_PROXY_* environment variables
//    (shared/proxy-config.mjs builds them; the config file reads them), so
//    the app's runner and the MCP server hand Playwright the same answer.
//    `runProxyEnv` is the app-side wrapper that adds the decrypted password.
//
// Proxy AUTHENTICATION is answered in two places, both here: `app.on("login")`
// for webContents traffic (the training browser), and the per-request `login`
// event for the `net.request` the test-traffic validator makes. Node-side
// requests carry credentials in the dispatcher instead. Credentials only
// exist in manual mode — automatic mode has nowhere to type them.

import { Buffer } from "node:buffer";

import type { Dispatcher } from "undici";

import { app, logger, net, session } from "@shell/backend";

import {
  isLoopbackHost,
  manualProxyFor,
  playwrightProxyEnv,
  proxyAppliesTo,
} from "../../shared/proxy-config.mjs";
import type { PlaywrightProxyEnv, ProxySettings } from "../../shared/proxy-config.mjs";
import { recorderSettingsStore } from "./recorder-settings-store.js";
import { proxyPasswordStore } from "./proxy-password-store.js";

/** The current proxy-shaped settings. The store validates on every read, so
 *  this is already canonical. */
function proxySettings(): ProxySettings {
  return recorderSettingsStore.get();
}

// undici is imported DYNAMICALLY, and only on the first request that actually
// needs a proxy — the same shape as metrics-store's `node:sqlite` import and
// for the bundling half of the same reason: undici is CommonJS, and a static
// import of it in an esbuild ESM bundle emits a `__require` shim that throws
// on its `require("node:assert")` AT MODULE LOAD. The app bundle carries a
// createRequire banner that makes that legal (scripts/build-main.mjs); the
// check:* bundles deliberately do not, and this module reaches them through
// playwright-runner. Lazy, the require runs only when a proxy is in play,
// which is never in a check — and the type-only import above is erased.
type UndiciModule = typeof import("undici");
let undiciModule: Promise<UndiciModule> | null = null;
function loadUndici(): Promise<UndiciModule> {
  undiciModule ??= import("undici");
  return undiciModule;
}

// ── Deciding what one app-traffic request should do ─────────────────────────

/** What one request should do. `sslVerify` is only ever false for a MANUAL
 *  proxy — an automatic (OS) proxy keeps full verification, because "SSL
 *  Verify" is scoped to the proxy the user configured and said they trust. */
export type AppProxyDecision =
  | { kind: "direct"; reason: "off" | "loopback" | "os-direct" | "unparseable" }
  | { kind: "proxy"; url: string; username: string; password: string | null; sslVerify: boolean };

/**
 * Chromium's PAC-style resolver result ("PROXY h:p; SOCKS5 h:p; DIRECT") as
 * proxy URLs in preference order, with "direct" for DIRECT entries. Entry
 * types undici cannot drive (SOCKS4, QUIC) are dropped rather than guessed at
 * — the next candidate is what Chromium itself would fall back to.
 */
export function parsePacProxies(result: string): string[] {
  const out: string[] = [];
  for (const rawEntry of String(result || "").split(";")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    if (/^DIRECT$/i.test(entry)) {
      out.push("direct");
      continue;
    }
    const match = /^(PROXY|HTTPS|SOCKS5|SOCKS)\s+(\S+)$/i.exec(entry);
    if (!match) continue;
    const type = match[1].toUpperCase();
    const hostPort = match[2];
    if (type === "PROXY") out.push(`http://${hostPort}`);
    else if (type === "HTTPS") out.push(`https://${hostPort}`);
    else out.push(`socks5://${hostPort}`);
  }
  return out;
}

/**
 * The decision for one URL, with the settings and the OS resolver handed in —
 * which is what makes the rule testable without Electron. `appProxyDecision`
 * below is the bound version everything else calls.
 */
export async function decideAppProxy(
  settings: ProxySettings,
  targetUrl: string,
  resolveOsProxy: (url: string) => Promise<string>,
  password: () => Promise<string | null>,
): Promise<AppProxyDecision> {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    // Let the fetch itself throw the real error — a proxy decision has no
    // business inventing one for a URL nothing can request.
    return { kind: "direct", reason: "unparseable" };
  }
  if (isLoopbackHost(target.hostname)) return { kind: "direct", reason: "loopback" };
  if (!proxyAppliesTo(settings, "app")) return { kind: "direct", reason: "off" };

  const manual = manualProxyFor(settings, "app");
  if (manual) {
    return {
      kind: "proxy",
      url: manual.url,
      username: manual.username,
      password: manual.username ? await password() : null,
      sslVerify: manual.sslVerify,
    };
  }
  // Manual mode with nothing usable configured is direct — "optionally
  // supplied proxy settings", not an error.
  if (settings.proxySource === "manual") return { kind: "direct", reason: "off" };

  // Automatic: the OS decides, per URL, PAC files included.
  let resolved = "";
  try {
    resolved = await resolveOsProxy(targetUrl);
  } catch (err) {
    logger.warn("proxy", "Could not resolve the OS proxy; connecting directly", {
      message: err instanceof Error ? err.message : String(err),
    });
    return { kind: "direct", reason: "os-direct" };
  }
  for (const candidate of parsePacProxies(resolved)) {
    if (candidate === "direct") return { kind: "direct", reason: "os-direct" };
    return { kind: "proxy", url: candidate, username: "", password: null, sslVerify: true };
  }
  return { kind: "direct", reason: "os-direct" };
}

/** The bound decision: current settings, Electron's default-session resolver,
 *  the encrypted password store. */
async function appProxyDecision(targetUrl: string): Promise<AppProxyDecision> {
  return decideAppProxy(
    proxySettings(),
    targetUrl,
    (url) => session.defaultSession.resolveProxy(url),
    () => proxyPasswordStore.get(),
  );
}

// ── Dispatchers ──────────────────────────────────────────────────────────────

/** Live undici agents, one per distinct proxy decision. Reused because each
 *  holds a connection pool; `refreshProxy()` closes and drops them all when
 *  the settings change, so a stale pool cannot outlive its configuration. */
const dispatchers = new Map<string, Dispatcher>();

async function dispatcherFor(
  decision: Extract<AppProxyDecision, { kind: "proxy" }>,
): Promise<Dispatcher> {
  const key = [decision.url, decision.username, decision.password ?? "", decision.sslVerify].join(
    " ",
  );
  const cached = dispatchers.get(key);
  if (cached) return cached;

  const { ProxyAgent, Socks5ProxyAgent } = await loadUndici();
  // Re-checked after the await: two concurrent first requests both get here,
  // and the loser must adopt the winner's agent rather than orphan a pool.
  const raced = dispatchers.get(key);
  if (raced) return raced;

  const tls = decision.sslVerify ? undefined : { rejectUnauthorized: false };
  let agent: Dispatcher;
  if (decision.url.startsWith("socks5:")) {
    agent = new Socks5ProxyAgent(decision.url, {
      ...(decision.username
        ? { username: decision.username, password: decision.password ?? "" }
        : {}),
      ...(tls ? { proxyTls: tls } : {}),
    });
  } else {
    agent = new ProxyAgent({
      uri: decision.url,
      ...(decision.username
        ? {
            token: `Basic ${Buffer.from(
              `${decision.username}:${decision.password ?? ""}`,
            ).toString("base64")}`,
          }
        : {}),
      ...(tls ? { requestTls: tls, proxyTls: tls } : {}),
    });
  }
  dispatchers.set(key, agent);
  return agent;
}

/** Drop (and close) every cached agent. Called when the proxy settings or the
 *  stored password change, so the next request re-decides from scratch. */
function closeDispatchers(): void {
  for (const agent of dispatchers.values()) {
    void agent.close().catch(() => {});
  }
  dispatchers.clear();
}

// ── The app-traffic fetch ────────────────────────────────────────────────────

/**
 * `fetch` for the app's own outbound requests — the AI providers, GitHub, the
 * webhooks. Byte-identical to global fetch until the proxy settings say
 * otherwise, which keeps every existing caller and test exactly as it was.
 *
 * Proxied requests go through undici's own fetch with a dispatcher rather
 * than global fetch: the global one is Node's bundled undici, and handing it
 * an agent from the npm copy works only by coincidence of versions. The
 * response object satisfies everything the callers use (ok/status/json/text
 * and an async-iterable body for the SSE streams).
 */
export async function appFetch(url: string, init?: RequestInit): Promise<Response> {
  const decision = await appProxyDecision(url);
  if (decision.kind === "direct") return fetch(url, init);
  const [{ fetch: undiciFetch }, dispatcher] = await Promise.all([
    loadUndici(),
    dispatcherFor(decision),
  ]);
  return undiciFetch(url, {
    ...(init as Record<string, unknown> | undefined),
    dispatcher,
  } as never) as unknown as Promise<Response>;
}

/**
 * Environment for a proxy-aware child process download — the Playwright
 * browser installer. It is APP traffic (the app fetching its own tooling, not
 * the system under test), and the installer honours the conventional
 * HTTPS_PROXY/HTTP_PROXY variables. Credentials ride in the URL here because
 * that is the convention's only slot for them; it is a child process
 * environment, not a file.
 */
export async function downloadProxyEnv(): Promise<NodeJS.ProcessEnv> {
  const manual = manualProxyFor(proxySettings(), "app");
  if (!manual || manual.url.startsWith("socks5:")) return {};
  let credentialed = manual.url;
  if (manual.username) {
    const password = (await proxyPasswordStore.get()) ?? "";
    const parsed = new URL(manual.url);
    parsed.username = manual.username;
    parsed.password = password;
    credentialed = parsed.toString().replace(/\/$/, "");
  }
  return {
    HTTPS_PROXY: credentialed,
    HTTP_PROXY: credentialed,
    NO_PROXY: "localhost,127.0.0.1,::1",
  };
}

/** The PW_PROXY_* environment for a test run, password included — the app
 *  side of the rule the MCP server applies without one. */
export async function runProxyEnv(): Promise<PlaywrightProxyEnv> {
  const settings = proxySettings();
  const manual = manualProxyFor(settings, "test");
  const password = manual?.username ? await proxyPasswordStore.get() : null;
  return playwrightProxyEnv(settings, password);
}

// ── Chromium sessions ────────────────────────────────────────────────────────

/** Accept any certificate except on loopback, where there is no proxy in the
 *  path to blame. 0 = trust, -3 = use Chromium's own verdict. */
function relaxedVerifyProc(
  request: { hostname: string },
  callback: (verificationResult: number) => void,
): void {
  callback(isLoopbackHost(request.hostname) ? -3 : 0);
}

/**
 * Point one Chromium session at the configured proxy — or explicitly back at
 * the system configuration, which is how a switch AWAY from manual takes
 * effect on a session that outlives the settings change.
 */
async function applySessionProxy(ses: Electron.Session, kind: "app" | "test"): Promise<void> {
  const manual = manualProxyFor(proxySettings(), kind);
  if (manual) {
    await ses.setProxy({ proxyRules: manual.url });
    ses.setCertificateVerifyProc(manual.sslVerify ? null : relaxedVerifyProc);
    logger.info("proxy", `Applied the manual proxy to a ${kind} session`, {
      proxyUrl: manual.url,
      sslVerify: manual.sslVerify,
    });
  } else {
    await ses.setProxy({ mode: "system" });
    ses.setCertificateVerifyProc(null);
  }
}

/** The training browser's per-recording partition. Called by recorder-service
 *  after it creates the page view and BEFORE the first navigation — a proxy
 *  applied after the load starts is a recording whose first page took the
 *  wrong network path. Failure degrades to direct, logged: a recording that
 *  can't start is worse than one that ignored a proxy it couldn't apply. */
export async function applyTestSessionProxy(ses: Electron.Session): Promise<void> {
  try {
    await applySessionProxy(ses, "test");
  } catch (err) {
    logger.warn("proxy", "Could not apply the proxy to the training session", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The default session — where the renderer's own web fetches (site icons)
 *  land. App traffic, so it follows the "app" class. */
async function applyAppDefaultSessionProxy(): Promise<void> {
  try {
    await applySessionProxy(session.defaultSession, "app");
  } catch (err) {
    logger.warn("proxy", "Could not apply the proxy to the default session", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Auth ─────────────────────────────────────────────────────────────────────

/** Answer an authenticating proxy's challenge for webContents traffic with
 *  the manual credentials, when there are any. Page-level (non-proxy) auth is
 *  deliberately left alone — this feature is about the proxy. */
function installLoginHandler(): void {
  app.on(
    "login",
    (
      event: { preventDefault(): void },
      _webContents: unknown,
      _details: unknown,
      authInfo: { isProxy?: boolean },
      callback: (username?: string, password?: string) => void,
    ) => {
      if (!authInfo?.isProxy) return;
      const settings = proxySettings();
      const manual = manualProxyFor(settings, "test") ?? manualProxyFor(settings, "app");
      if (!manual || !manual.username) return; // unhandled = auth cancelled, as before
      event.preventDefault();
      proxyPasswordStore
        .get()
        .then((password) => callback(manual.username, password ?? ""))
        .catch(() => callback());
    },
  );
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/** Boot-time wiring: the login answerer and the default session's state.
 *  Called once from main/index.ts after `whenReady`. */
export async function initProxyService(): Promise<void> {
  installLoginHandler();
  await applyAppDefaultSessionProxy();
}

/** The settings changed (or the password did): drop every cached dispatcher
 *  and re-point the default session. The training browser's partition is
 *  per-recording and picks the new settings up when the next recording
 *  starts; a live one keeps the configuration it opened with. */
export async function refreshProxy(): Promise<void> {
  closeDispatchers();
  await applyAppDefaultSessionProxy();
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface ProxyVerifyResult {
  ok: boolean;
  /** What was checked. */
  url: string;
  /** How the connection was made: "manual proxy …", "system settings", or
   *  "direct" — so a green result can't silently mean "the proxy was never
   *  in the path". */
  via: string;
  /** One human sentence about what happened. */
  detail: string;
}

function describeVia(decision: AppProxyDecision): string {
  if (decision.kind === "proxy") return `proxy ${decision.url}`;
  if (decision.reason === "loopback") return "direct — loopback never proxies";
  if (decision.reason === "os-direct") return "direct — the OS settings name no proxy";
  return "direct";
}

/** A network failure as one sentence with the useful part kept. */
function describeFetchError(err: unknown): string {
  const parts: string[] = [];
  let cursor: unknown = err;
  for (let depth = 0; cursor instanceof Error && depth < 4; depth++) {
    parts.push(cursor.message);
    cursor = (cursor as { cause?: unknown }).cause;
  }
  const joined = parts.filter(Boolean).join(" — ") || String(err);
  if (/407|Proxy response/i.test(joined)) {
    return `${joined}. The proxy refused the credentials — check the username and password.`;
  }
  if (/certificate|CERT_/i.test(joined)) {
    return `${joined}. If the proxy re-signs traffic, uncheck SSL Verify.`;
  }
  return joined;
}

/**
 * "Verify app connectivity": one request to `targetUrl` through exactly the
 * path the app's own traffic takes. ANY HTTP status is reachability — a 401
 * from an API proves the network path as well as a 200 does.
 */
export async function verifyAppConnectivity(targetUrl: string): Promise<ProxyVerifyResult> {
  const decision = await appProxyDecision(targetUrl);
  const via = describeVia(decision);
  try {
    const res = await appFetch(targetUrl, {
      method: "GET",
      signal: AbortSignal.timeout(12_000),
    });
    return {
      ok: true,
      url: targetUrl,
      via,
      detail: `Reached ${new URL(targetUrl).host} (HTTP ${res.status}, ${via}).`,
    };
  } catch (err) {
    return { ok: false, url: targetUrl, via, detail: describeFetchError(err) };
  }
}

/** net error codes worth a sentence more than Chromium gives them. */
function describeNetError(code: string): string {
  if (/PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED/.test(code)) {
    return `${code} — could not connect through the proxy. Check the proxy URL and port.`;
  }
  if (/PROXY_AUTH/.test(code)) {
    return `${code} — the proxy wants credentials it did not accept.`;
  }
  if (/NO_SUPPORTED_PROXIES|MANDATORY_PROXY/.test(code)) {
    return `${code} — the proxy configuration could not be used.`;
  }
  if (/CERT_/.test(code)) {
    return `${code} — certificate rejected. If the proxy re-signs traffic, uncheck SSL Verify.`;
  }
  if (/NAME_NOT_RESOLVED/.test(code)) {
    return `${code} — the host could not be resolved.`;
  }
  return code;
}

/**
 * "Verify test connectivity": one request to a user-typed URL through a
 * throwaway session configured EXACTLY as the training browser's would be —
 * same setProxy, same certificate proc, same credential answer. It shares
 * Chromium's network stack with the trainer and the Playwright browsers
 * without launching one, which is also its honest limit: mabl's own page
 * carries the caveat that a validation can disagree with a real run, and so
 * does the dialog this answers.
 */
export async function verifyTestConnectivity(targetUrl: string): Promise<ProxyVerifyResult> {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return { ok: false, url: targetUrl, via: "—", detail: "Enter a full URL, like https://staging.example.com." };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { ok: false, url: targetUrl, via: "—", detail: "Only http:// and https:// URLs can be checked." };
  }

  const settings = proxySettings();
  const manual = manualProxyFor(settings, "test");
  const via = manual ? `proxy ${manual.url}` : "system settings";
  const ses = session.fromPartition(`proxy-verify-${Date.now()}-${Math.random()}`);
  await applyTestSessionProxy(ses);

  return await new Promise<ProxyVerifyResult>((resolvePromise) => {
    let settled = false;
    const settle = (result: ProxyVerifyResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      try {
        request.abort();
      } catch {
        /* already ended */
      }
      settle({
        ok: false,
        url: targetUrl,
        via,
        detail: "Timed out after 15 seconds — nothing answered through this configuration.",
      });
    }, 15_000);

    const request = net.request({ url: target.toString(), session: ses });
    request.on("login", (_authInfo, callback) => {
      if (!manual || !manual.username) {
        callback(); // cancel — same as an unanswered challenge anywhere else
        return;
      }
      proxyPasswordStore
        .get()
        .then((password) => callback(manual.username, password ?? ""))
        .catch(() => callback());
    });
    request.on("response", (response) => {
      settle({
        ok: true,
        url: targetUrl,
        via,
        detail: `Reached ${target.host} (HTTP ${response.statusCode}, via ${via}).`,
      });
      // Drained and discarded: the status line is the whole answer, and an
      // unconsumed response keeps its socket open.
      response.on("data", () => {});
      response.on("end", () => {});
    });
    request.on("error", (err: Error) => {
      settle({ ok: false, url: targetUrl, via, detail: describeNetError(err.message) });
    });
    request.end();
  });
}
