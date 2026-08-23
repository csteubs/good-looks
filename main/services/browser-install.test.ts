import { describe, expect, it } from "vitest";

import { browserInstalledIn, expectedBrowserDirs } from "../../shared/browser-install.mjs";

const JSON_162 = JSON.stringify({
  browsers: [
    { name: "chromium", revision: "1234", installByDefault: true },
    { name: "chromium-headless-shell", revision: "1234", installByDefault: true },
    { name: "firefox", revision: "1538" },
    { name: "webkit", revision: "2336" },
    { name: "ffmpeg", revision: "1011" },
  ],
});

describe("expectedBrowserDirs", () => {
  it("names the full browser AND the headless shell for chromium, at the CLI's revision", () => {
    expect(expectedBrowserDirs(JSON_162, "chromium")).toEqual(["chromium-1234", "chromium_headless_shell-1234"]);
    expect(expectedBrowserDirs(JSON_162, "firefox")).toEqual(["firefox-1538"]);
    expect(expectedBrowserDirs(JSON_162, "webkit")).toEqual(["webkit-2336"]);
  });

  it("answers null for a file it cannot read or that does not name the engine", () => {
    expect(expectedBrowserDirs("not json", "chromium")).toBeNull();
    expect(expectedBrowserDirs(JSON.stringify({ browsers: [{ name: "webkit", revision: "1" }] }), "chromium")).toBeNull();
  });
});

describe("browserInstalledIn", () => {
  const dirs = expectedBrowserDirs(JSON_162, "chromium");
  it("is not fooled by an older revision left from the previous Playwright", () => {
    // The 1.53 → 1.62 failure: chromium-1178 on disk, 1234 wanted.
    expect(browserInstalledIn(["chromium-1178", "chromium_headless_shell-1178", "ffmpeg-1011"], "chromium", dirs)).toBe(false);
  });
  it("needs both chromium directories, not just one", () => {
    expect(browserInstalledIn(["chromium-1234"], "chromium", dirs)).toBe(false);
    expect(browserInstalledIn(["chromium-1234", "chromium_headless_shell-1234"], "chromium", dirs)).toBe(true);
  });
  it("falls back to the prefix rule when the CLI's manifest is unavailable", () => {
    expect(browserInstalledIn(["chromium-1178"], "chromium", null)).toBe(true);
    expect(browserInstalledIn(["chromium_headless_shell-1178"], "chromium", null)).toBe(false);
  });
});
