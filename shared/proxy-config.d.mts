// Types for proxy-config.mjs.
//
// Hand-written, like every .d.mts in this directory: the implementation is
// plain ESM so the standalone MCP server can import it without a build step,
// and this file is what keeps `npm run type-check` a real gate over every
// TypeScript caller. The unions are declared HERE and imported by both
// RecorderSettings mirrors, so a value added to the vocabulary without a rule
// for it is a compile error rather than a setting that saves and does nothing.

export type ProxyTraffic = "none" | "app" | "test" | "both";
export type ProxySource = "automatic" | "manual";

/** The proxy-shaped subset of RecorderSettings. The password is deliberately
 *  not part of it — it lives encrypted in the app's safeStorage and is handed
 *  in where needed. */
export interface ProxySettings {
  proxyTraffic: ProxyTraffic;
  proxySource: ProxySource;
  proxyUrl: string;
  proxyUsername: string;
  proxySslVerify: boolean;
}

export declare const PROXY_TRAFFIC_VALUES: readonly ProxyTraffic[];
export declare const PROXY_SOURCE_VALUES: readonly ProxySource[];
export declare const PROXY_URL_SCHEMES: readonly string[];
export declare const PROXY_DEFAULTS: Readonly<ProxySettings>;

export declare function isProxyTraffic(v: unknown): v is ProxyTraffic;
export declare function isProxySource(v: unknown): v is ProxySource;

export declare function normalizeProxyUrl(
  raw: unknown,
): { ok: true; url: string } | { ok: false; reason: string };

export declare function proxySettingsFrom(raw: unknown): ProxySettings;

export declare function proxyAppliesTo(
  settings: Pick<ProxySettings, "proxyTraffic"> | null | undefined,
  kind: "app" | "test",
): boolean;

export interface ManualProxy {
  url: string;
  username: string;
  sslVerify: boolean;
}

export declare function manualProxyFor(
  settings: ProxySettings,
  kind: "app" | "test",
): ManualProxy | null;

export interface PlaywrightProxyEnv {
  PW_PROXY_SERVER?: string;
  PW_PROXY_USERNAME?: string;
  PW_PROXY_PASSWORD?: string;
  PW_IGNORE_HTTPS_ERRORS?: string;
}

export declare function playwrightProxyEnv(
  settings: ProxySettings,
  password: string | null,
): PlaywrightProxyEnv;

export declare function isLoopbackHost(hostname: string | null | undefined): boolean;
