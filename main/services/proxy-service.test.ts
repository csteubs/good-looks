// The proxy decision, exercised through its injectable form. The bound
// wrappers (appFetch, applyTestSessionProxy) are thin bindings over these
// rules plus Electron objects the node project doesn't have; the rules are
// where a wrong answer routes traffic somewhere the user didn't write.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-proxy-service-test-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { decideAppProxy, parsePacProxies, appFetch } = await import("./proxy-service.js");
import type { ProxySettings } from "../../shared/proxy-config.mjs";

const neverResolve = (): Promise<string> => {
  throw new Error("resolveOsProxy must not be consulted here");
};
const noPassword = (): Promise<string | null> => Promise.resolve(null);

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parsePacProxies", () => {
  it("maps Chromium's resolver grammar onto proxy URLs in order", () => {
    expect(parsePacProxies("DIRECT")).toEqual(["direct"]);
    expect(parsePacProxies("PROXY 127.0.0.1:8888")).toEqual(["http://127.0.0.1:8888"]);
    expect(parsePacProxies("PROXY a:1; PROXY b:2; DIRECT")).toEqual([
      "http://a:1",
      "http://b:2",
      "direct",
    ]);
    expect(parsePacProxies("HTTPS secure:443")).toEqual(["https://secure:443"]);
    expect(parsePacProxies("SOCKS5 s:1080")).toEqual(["socks5://s:1080"]);
    expect(parsePacProxies("SOCKS s:1080")).toEqual(["socks5://s:1080"]);
  });

  it("drops what undici cannot drive rather than guessing", () => {
    expect(parsePacProxies("SOCKS4 s:1080; DIRECT")).toEqual(["direct"]);
    expect(parsePacProxies("QUIC q:443")).toEqual([]);
    expect(parsePacProxies("")).toEqual([]);
  });
});

describe("decideAppProxy", () => {
  it("never proxies loopback, even under a manual proxy", async () => {
    const decision = await decideAppProxy(
      manual(),
      "http://127.0.0.1:11434/api/tags",
      neverResolve,
      noPassword,
    );
    expect(decision).toEqual({ kind: "direct", reason: "loopback" });
  });

  it("is direct when app traffic is not covered", async () => {
    for (const proxyTraffic of ["none", "test"] as const) {
      const decision = await decideAppProxy(
        manual({ proxyTraffic }),
        "https://api.anthropic.com/v1/models",
        neverResolve,
        noPassword,
      );
      expect(decision).toEqual({ kind: "direct", reason: "off" });
    }
  });

  it("uses the manual proxy, fetching the password only when a username exists", async () => {
    const password = vi.fn(async () => "s3cret");
    const bare = await decideAppProxy(manual(), "https://example.com", neverResolve, password);
    expect(bare).toEqual({
      kind: "proxy",
      url: "http://proxy.corp:8080",
      username: "",
      password: null,
      sslVerify: true,
    });
    expect(password).not.toHaveBeenCalled();

    const authed = await decideAppProxy(
      manual({ proxyUsername: "svc", proxySslVerify: false }),
      "https://example.com",
      neverResolve,
      password,
    );
    expect(authed).toEqual({
      kind: "proxy",
      url: "http://proxy.corp:8080",
      username: "svc",
      password: "s3cret",
      sslVerify: false,
    });
  });

  it("is direct in manual mode with nothing usable configured", async () => {
    const decision = await decideAppProxy(
      manual({ proxyUrl: "" }),
      "https://example.com",
      neverResolve,
      noPassword,
    );
    expect(decision).toEqual({ kind: "direct", reason: "off" });
  });

  it("asks the OS in automatic mode and follows its first usable answer", async () => {
    const settings = manual({ proxySource: "automatic" });
    expect(
      await decideAppProxy(settings, "https://example.com", async () => "DIRECT", noPassword),
    ).toEqual({ kind: "direct", reason: "os-direct" });

    expect(
      await decideAppProxy(
        settings,
        "https://example.com",
        async () => "PROXY 10.0.0.1:3128; DIRECT",
        noPassword,
      ),
    ).toEqual({
      kind: "proxy",
      url: "http://10.0.0.1:3128",
      username: "",
      password: null,
      sslVerify: true,
    });

    // An OS proxy never inherits the manual credentials or the SSL Verify
    // relaxation — both belong to the proxy the user configured by hand.
    const relaxed = await decideAppProxy(
      manual({ proxySource: "automatic", proxyUsername: "svc", proxySslVerify: false }),
      "https://example.com",
      async () => "PROXY 10.0.0.1:3128",
      noPassword,
    );
    expect(relaxed).toEqual({
      kind: "proxy",
      url: "http://10.0.0.1:3128",
      username: "",
      password: null,
      sslVerify: true,
    });
  });

  it("degrades to direct when the OS resolver itself fails", async () => {
    const decision = await decideAppProxy(
      manual({ proxySource: "automatic" }),
      "https://example.com",
      async () => {
        throw new Error("no session yet");
      },
      noPassword,
    );
    expect(decision).toEqual({ kind: "direct", reason: "os-direct" });
  });
});

describe("appFetch", () => {
  it("is plain global fetch while the proxy is off — same call, same answer", async () => {
    // The default settings (traffic "none") are what every existing caller
    // runs under; this pins that the swap from fetch() to appFetch() changed
    // nothing for them.
    const stub = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", stub);
    const res = await appFetch("https://example.com/api", { method: "POST" });
    expect(res.status).toBe(200);
    expect(stub).toHaveBeenCalledWith("https://example.com/api", { method: "POST" });
  });
});
