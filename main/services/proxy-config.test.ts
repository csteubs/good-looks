// The shared proxy rules (shared/proxy-config.mjs), tested from the node
// project like branch-paths.test.ts — the module itself is plain ESM with no
// test glob of its own.
//
// The matrix cases matter more than they look: `playwrightProxyEnv` is the ONE
// rule deciding whether a run gets a proxy, and it is called from two
// processes (the app's runner and the MCP server). A wrong answer here is a
// run that quietly uses the wrong network path and passes anyway.

import { describe, expect, it } from "vitest";

import {
  isLoopbackHost,
  isProxySource,
  isProxyTraffic,
  manualProxyFor,
  normalizeProxyUrl,
  playwrightProxyEnv,
  PROXY_DEFAULTS,
  proxyAppliesTo,
  proxySettingsFrom,
} from "../../shared/proxy-config.mjs";
import type { ProxySettings } from "../../shared/proxy-config.mjs";

function manual(overrides: Partial<ProxySettings> = {}): ProxySettings {
  return {
    proxyTraffic: "both",
    proxySource: "manual",
    proxyUrl: "http://proxy.corp:8080",
    proxyUsername: "",
    proxySslVerify: true,
    ...overrides,
  };
}

describe("normalizeProxyUrl", () => {
  it("accepts http, https and socks5 and canonicalises", () => {
    expect(normalizeProxyUrl("http://192.168.0.1:8080")).toEqual({
      ok: true,
      url: "http://192.168.0.1:8080",
    });
    expect(normalizeProxyUrl("  https://proxy.corp:3128/  ")).toEqual({
      ok: true,
      url: "https://proxy.corp:3128",
    });
    expect(normalizeProxyUrl("socks5://10.0.0.1:1080")).toEqual({
      ok: true,
      url: "socks5://10.0.0.1:1080",
    });
  });

  it("drops a default port the same way every consumer does", () => {
    expect(normalizeProxyUrl("http://proxy.corp:80")).toEqual({ ok: true, url: "http://proxy.corp" });
  });

  it("refuses empty, unparseable and off-list schemes", () => {
    expect(normalizeProxyUrl("").ok).toBe(false);
    expect(normalizeProxyUrl("   ").ok).toBe(false);
    expect(normalizeProxyUrl("not a url").ok).toBe(false);
    expect(normalizeProxyUrl("ftp://proxy:21").ok).toBe(false);
    // A bare host parses as a relative URL and must not slip through.
    expect(normalizeProxyUrl("proxy.corp:8080").ok).toBe(false);
  });

  it("refuses credentials in the URL — the URL is stored in plain JSON", () => {
    const result = normalizeProxyUrl("http://user:secret@proxy.corp:8080");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Password");
    expect(normalizeProxyUrl("http://useronly@proxy.corp:8080").ok).toBe(false);
  });

  it("refuses a path — a proxy URL is scheme, host and port", () => {
    expect(normalizeProxyUrl("http://proxy.corp:8080/pac").ok).toBe(false);
  });
});

describe("proxySettingsFrom", () => {
  it("returns the defaults for garbage input", () => {
    expect(proxySettingsFrom(null)).toEqual(PROXY_DEFAULTS);
    expect(proxySettingsFrom("nope")).toEqual(PROXY_DEFAULTS);
    expect(proxySettingsFrom({ proxyTraffic: "everything", proxySource: 3 })).toEqual(
      PROXY_DEFAULTS,
    );
  });

  it("keeps valid values and blanks an invalid stored URL", () => {
    const parsed = proxySettingsFrom({
      proxyTraffic: "test",
      proxySource: "manual",
      proxyUrl: "http://user:pw@proxy.corp:8080",
      proxyUsername: "user",
      proxySslVerify: false,
    });
    expect(parsed).toEqual({
      proxyTraffic: "test",
      proxySource: "manual",
      proxyUrl: "",
      proxyUsername: "user",
      proxySslVerify: false,
    });
  });

  it("rebuilds rather than filters — unknown keys do not survive", () => {
    const parsed = proxySettingsFrom({ proxyTraffic: "app", proxyPassword: "leak" });
    expect(Object.keys(parsed).sort()).toEqual([
      "proxySource",
      "proxySslVerify",
      "proxyTraffic",
      "proxyUrl",
      "proxyUsername",
    ]);
  });
});

describe("proxyAppliesTo / manualProxyFor", () => {
  it("covers the traffic matrix", () => {
    expect(proxyAppliesTo({ proxyTraffic: "none" }, "app")).toBe(false);
    expect(proxyAppliesTo({ proxyTraffic: "none" }, "test")).toBe(false);
    expect(proxyAppliesTo({ proxyTraffic: "app" }, "app")).toBe(true);
    expect(proxyAppliesTo({ proxyTraffic: "app" }, "test")).toBe(false);
    expect(proxyAppliesTo({ proxyTraffic: "test" }, "app")).toBe(false);
    expect(proxyAppliesTo({ proxyTraffic: "test" }, "test")).toBe(true);
    expect(proxyAppliesTo({ proxyTraffic: "both" }, "app")).toBe(true);
    expect(proxyAppliesTo({ proxyTraffic: "both" }, "test")).toBe(true);
  });

  it("is null for automatic mode — the OS decides, we change nothing", () => {
    expect(manualProxyFor(manual({ proxySource: "automatic" }), "test")).toBeNull();
  });

  it("is null for an uncovered class and for traffic none", () => {
    expect(manualProxyFor(manual({ proxyTraffic: "app" }), "test")).toBeNull();
    expect(manualProxyFor(manual({ proxyTraffic: "none" }), "test")).toBeNull();
  });

  it("is null in manual mode with no usable URL — optional, not an error", () => {
    expect(manualProxyFor(manual({ proxyUrl: "" }), "test")).toBeNull();
    expect(manualProxyFor(manual({ proxyUrl: "garbage" }), "test")).toBeNull();
  });

  it("returns the manual proxy when covered", () => {
    expect(manualProxyFor(manual({ proxyUsername: "u" }), "test")).toEqual({
      url: "http://proxy.corp:8080",
      username: "u",
      sslVerify: true,
    });
  });
});

describe("playwrightProxyEnv", () => {
  it("is empty when nothing manual applies", () => {
    expect(playwrightProxyEnv(manual({ proxySource: "automatic" }), "pw")).toEqual({});
    expect(playwrightProxyEnv(manual({ proxyTraffic: "app" }), "pw")).toEqual({});
    expect(playwrightProxyEnv(manual({ proxyTraffic: "none" }), "pw")).toEqual({});
    expect(playwrightProxyEnv(manual({ proxyUrl: "" }), "pw")).toEqual({});
  });

  it("carries the server, and the credentials only as a pair", () => {
    expect(playwrightProxyEnv(manual(), null)).toEqual({
      PW_PROXY_SERVER: "http://proxy.corp:8080",
    });
    // The MCP case: a username is configured but the password is encrypted to
    // the app. The username still goes — the run fails AT the proxy, naming
    // it, rather than silently going direct and passing on the wrong path.
    expect(playwrightProxyEnv(manual({ proxyUsername: "u" }), null)).toEqual({
      PW_PROXY_SERVER: "http://proxy.corp:8080",
      PW_PROXY_USERNAME: "u",
    });
    expect(playwrightProxyEnv(manual({ proxyUsername: "u" }), "pw")).toEqual({
      PW_PROXY_SERVER: "http://proxy.corp:8080",
      PW_PROXY_USERNAME: "u",
      PW_PROXY_PASSWORD: "pw",
    });
    // A password with no username is not a credential any scheme can spend.
    expect(playwrightProxyEnv(manual(), "pw")).toEqual({
      PW_PROXY_SERVER: "http://proxy.corp:8080",
    });
  });

  it("flags ignore-https-errors only when SSL verify is off", () => {
    expect(playwrightProxyEnv(manual({ proxySslVerify: false }), null)).toEqual({
      PW_PROXY_SERVER: "http://proxy.corp:8080",
      PW_IGNORE_HTTPS_ERRORS: "1",
    });
    expect(playwrightProxyEnv(manual(), null).PW_IGNORE_HTTPS_ERRORS).toBeUndefined();
  });
});

describe("isLoopbackHost", () => {
  it("matches the machine's own addresses and nothing else", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("app.localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.9.9.9")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("128.0.0.1")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
    // Anchored: a public name that merely STARTS with a loopback address must
    // not bypass the proxy.
    expect(isLoopbackHost("127.0.0.1.evil.example")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
  });
});

describe("type guards", () => {
  it("accept the vocabulary and refuse the rest", () => {
    expect(isProxyTraffic("both")).toBe(true);
    expect(isProxyTraffic("everything")).toBe(false);
    expect(isProxySource("manual")).toBe(true);
    expect(isProxySource("pac")).toBe(false);
  });
});
