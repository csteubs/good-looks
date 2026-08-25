// When a URL field says what it will open (#134).
//
// The rule under this is `shared/start-url.mjs`, pinned in
// `main/services/start-url.test.ts`. What is pinned here is the DISPLAY
// decision: a note appears only when the app is adding something the user did
// not type. Both dialogs that take a typed site read this, so a change here
// changes both — which is the point of it existing.

import { describe, it, expect } from "vitest";

import { startUrlHint } from "./start-url-hint";

describe("startUrlHint", () => {
  it("says what a bare host will open", () => {
    expect(startUrlHint("example.com")).toBe("https://example.com");
    expect(startUrlHint("  example.com/cart ")).toBe("https://example.com/cart");
  });

  it("stays quiet when the typed URL already names its scheme", () => {
    // Repeating the field back is noise, and noise beside a field is how people
    // stop reading the one time it matters. The silence is also information: it
    // is what tells someone their `http://` was not upgraded behind their back.
    expect(startUrlHint("https://example.com")).toBeNull();
    expect(startUrlHint("http://localhost:3000")).toBeNull();
    expect(startUrlHint("  https://example.com  ")).toBeNull();
  });

  it("stays quiet on an empty field", () => {
    expect(startUrlHint("")).toBeNull();
    expect(startUrlHint("   ")).toBeNull();
  });
});
