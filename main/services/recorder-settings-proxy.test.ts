// The proxy settings' trip through the store, both ways — the same shape as
// recorder-settings-cost.test.ts and for a sharper reason: these keys decide
// which NETWORK PATH the app's requests, the training browser and every test
// run take. A value refused on load but accepted on save is written to disk
// and then ignored forever ("the setting does not work"); a value accepted
// that shouldn't be is traffic routed somewhere the user didn't write.
//
// The URL cases are the boundary ones. The settings file is hand-editable and
// plain JSON, and the whole reason the proxy password lives in safeStorage is
// that this file is not encrypted — so a URL smuggling credentials must be
// blanked on BOTH paths, or the encryption is decorative.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-proxy-settings-test-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { recorderSettingsStore } = await import("./recorder-settings-store.js");

const settingsFile = path.join(userData, "recorder", "recorder-settings.json");

/** Write a raw settings file, the way a hand edit or a bad migration would. */
function writeRaw(patch: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(patch), "utf-8");
}

beforeEach(() => {
  fs.rmSync(settingsFile, { force: true });
});

describe("defaults", () => {
  it("ships inert: no traffic proxied, automatic source, nothing configured", () => {
    const s = recorderSettingsStore.get();
    expect(s.proxyTraffic).toBe("none");
    expect(s.proxySource).toBe("automatic");
    expect(s.proxyUrl).toBe("");
    expect(s.proxyUsername).toBe("");
    expect(s.proxySslVerify).toBe(true);
  });
});

describe("reading a hand-edited file", () => {
  it("keeps a valid manual configuration exactly", () => {
    writeRaw({
      proxyTraffic: "both",
      proxySource: "manual",
      proxyUrl: "http://proxy.corp:8080",
      proxyUsername: "svc-tests",
      proxySslVerify: false,
    });
    const s = recorderSettingsStore.get();
    expect(s.proxyTraffic).toBe("both");
    expect(s.proxySource).toBe("manual");
    expect(s.proxyUrl).toBe("http://proxy.corp:8080");
    expect(s.proxyUsername).toBe("svc-tests");
    expect(s.proxySslVerify).toBe(false);
  });

  it("falls back on an unknown traffic or source value", () => {
    writeRaw({ proxyTraffic: "everything", proxySource: "pac" });
    const s = recorderSettingsStore.get();
    expect(s.proxyTraffic).toBe("none");
    expect(s.proxySource).toBe("automatic");
  });

  it("blanks a URL that smuggles credentials past the encrypted store", () => {
    writeRaw({ proxyUrl: "http://user:secret@proxy.corp:8080" });
    expect(recorderSettingsStore.get().proxyUrl).toBe("");
  });

  it("blanks a URL with an off-list scheme rather than handing it downstream", () => {
    writeRaw({ proxyUrl: "ftp://proxy.corp:21" });
    expect(recorderSettingsStore.get().proxyUrl).toBe("");
  });
});

describe("saving over IPC", () => {
  it("canonicalises a saved URL", () => {
    const s = recorderSettingsStore.set({ proxyUrl: "https://proxy.corp:3128/" });
    expect(s.proxyUrl).toBe("https://proxy.corp:3128");
  });

  it("blanks an invalid or credential-carrying URL on save, same as on load", () => {
    recorderSettingsStore.set({ proxyUrl: "http://proxy.corp:8080" });
    const s = recorderSettingsStore.set({ proxyUrl: "http://u:p@proxy.corp:8080" });
    expect(s.proxyUrl).toBe("");
  });

  it("lets an empty string clear the URL", () => {
    recorderSettingsStore.set({ proxyUrl: "http://proxy.corp:8080" });
    expect(recorderSettingsStore.set({ proxyUrl: "" }).proxyUrl).toBe("");
  });

  it("refuses an off-vocabulary traffic value and keeps the current one", () => {
    recorderSettingsStore.set({ proxyTraffic: "test" });
    const s = recorderSettingsStore.set({
      proxyTraffic: "everything" as unknown as "both",
    });
    expect(s.proxyTraffic).toBe("test");
  });

  it("round-trips the whole configuration through disk", () => {
    recorderSettingsStore.set({
      proxyTraffic: "app",
      proxySource: "manual",
      proxyUrl: "socks5://10.0.0.1:1080",
      proxyUsername: "u",
      proxySslVerify: false,
    });
    const s = recorderSettingsStore.get();
    expect(s.proxyTraffic).toBe("app");
    expect(s.proxySource).toBe("manual");
    expect(s.proxyUrl).toBe("socks5://10.0.0.1:1080");
    expect(s.proxyUsername).toBe("u");
    expect(s.proxySslVerify).toBe(false);
  });
});
