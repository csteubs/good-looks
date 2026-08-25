// The scheme rule for a typed site (#134).
//
// It was a private function in `recorder-service.ts` until the New recording
// dialog needed to SHOW the answer rather than only obey it. Two copies of
// "what counts as already having a scheme" is the drift `shared/` exists to
// prevent: the note under the field and the address the training browser opens
// would agree the day they were written and silently disagree afterwards, and
// the failure mode is the user being told a lie about where they are recording.
//
// Lives here rather than beside `shared/start-url.mjs` for the reason
// `branch-paths.test.ts` gives: vitest's node project takes `main/**`, `mcp/**`
// and `renderer/lib/**`, so a test file under `shared/` matches NEITHER project
// and would pass by never running.

import { describe, it, expect } from "vitest";

import { hasScheme, normalizeStartUrl } from "../../shared/start-url.mjs";

describe("normalizeStartUrl", () => {
  it("adds https to a bare host", () => {
    expect(normalizeStartUrl("example.com")).toBe("https://example.com");
    expect(normalizeStartUrl("example.com/cart?a=1#x")).toBe("https://example.com/cart?a=1#x");
  });

  it("leaves a URL that names its own scheme alone", () => {
    // The http case is the one that matters: some internal test targets are not
    // on TLS, and a dialog that cannot express `http://localhost:3000` would be
    // a worse bug than the one being fixed.
    expect(normalizeStartUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeStartUrl("https://example.com")).toBe("https://example.com");
  });

  it("reads a scheme case-insensitively", () => {
    // A pasted `HTTPS://` is still a scheme. Matching case-sensitively would
    // produce `https://HTTPS://example.com`, which fails as an address rather
    // than as a typo anyone can see.
    expect(normalizeStartUrl("HTTPS://example.com")).toBe("HTTPS://example.com");
    expect(normalizeStartUrl("Http://localhost:3000")).toBe("Http://localhost:3000");
  });

  it("trims before deciding, and after", () => {
    expect(normalizeStartUrl("  example.com  ")).toBe("https://example.com");
    expect(normalizeStartUrl("  https://example.com ")).toBe("https://example.com");
  });

  it("answers `https://` for empty input, which is why callers gate", () => {
    // NOT a useful address, and that is the point of pinning it: the rule is a
    // pure string operation with no surprise default, so deciding what an empty
    // field MEANS belongs to the caller. `generate-test-dialog` learned that
    // the hard way — it applied the rule ungated on the create path and stored
    // `https://` as a test's site, a hostname nobody typed (#251). Both callers
    // now gate; this test is what says they have to.
    expect(normalizeStartUrl("")).toBe("https://");
    expect(normalizeStartUrl("   ")).toBe("https://");
  });
});

describe("hasScheme", () => {
  it("answers only for the two schemes this app opens", () => {
    expect(hasScheme("https://example.com")).toBe(true);
    expect(hasScheme("http://example.com")).toBe(true);
    expect(hasScheme("example.com")).toBe(false);
    // Not a scheme this app can open, so it is normalized like any other typed
    // text rather than being passed through as though it were an address.
    expect(hasScheme("file:///tmp/x.html")).toBe(false);
    expect(hasScheme("//example.com")).toBe(false);
  });
});
