// The pure half of overlay rules: which rules are armed for a URL, and what
// survives normalization on the way in.
//
// The normalizer is the security-boundary half. A rule's `target` originates in
// a PAGE — it comes from the element picker, which reads a document the user
// does not control — and it ends up resolved inside every document of every run
// of every test on that host. That is a longer life than a step's locator has,
// so it is checked at least as carefully.

import { describe, expect, it } from "vitest";

import {
  armedRulesFor,
  hostMatches,
  hostOf,
  MAX_RULES_PER_HOST,
  overlayVisible,
} from "../../shared/overlay-rules.mjs";
import { normalizeOverlayRule } from "../recorder/types.js";

const rule = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  host: "ritual.com",
  label: "Close",
  target: { k: "testid", v: "dg-header-close" },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe("hostOf", () => {
  it("lowercases and drops the scheme, port and path", () => {
    expect(hostOf("https://WWW.Ritual.com:8443/collections/all?x=1")).toBe("www.ritual.com");
  });

  it("answers empty for anything that is not a URL", () => {
    expect(hostOf("not a url")).toBe("");
    expect(hostOf("")).toBe("");
    expect(hostOf(null)).toBe("");
  });
});

describe("hostMatches", () => {
  it("matches the host itself and its subdomains", () => {
    expect(hostMatches("ritual.com", "https://ritual.com/")).toBe(true);
    expect(hostMatches("ritual.com", "https://www.ritual.com/")).toBe(true);
    expect(hostMatches("ritual.com", "https://shop.ritual.com/x")).toBe(true);
  });

  it("matches across schemes and ports, because a banner is a property of the site", () => {
    expect(hostMatches("ritual.com", "http://ritual.com/")).toBe(true);
    expect(hostMatches("ritual.com", "https://ritual.com:8443/")).toBe(true);
  });

  it("does NOT match a host that merely ends with the same letters", () => {
    // The whole reason this is not `endsWith`. A rule clicks things on a page,
    // so a rule that leaks onto an attacker-chosen lookalike domain is a rule
    // that clicks things there.
    expect(hostMatches("ritual.com", "https://evil-ritual.com/")).toBe(false);
    expect(hostMatches("ritual.com", "https://notritual.com/")).toBe(false);
  });

  it("is not fooled by a leading dot or odd casing on the stored host", () => {
    expect(hostMatches(".Ritual.com", "https://www.ritual.com/")).toBe(true);
  });

  it("answers false rather than throwing on junk", () => {
    expect(hostMatches("", "https://ritual.com/")).toBe(false);
    expect(hostMatches("ritual.com", "")).toBe(false);
  });
});

describe("armedRulesFor", () => {
  it("keeps only enabled rules whose host matches", () => {
    const rules = [
      rule({ id: "a" }),
      rule({ id: "b", disabled: true }),
      rule({ id: "c", host: "example.com" }),
    ];
    expect(armedRulesFor(rules, "https://www.ritual.com/").map((r) => r.id)).toEqual(["a"]);
  });

  it("caps a host's rules, and caps AFTER filtering so one host cannot starve another", () => {
    const many = Array.from({ length: MAX_RULES_PER_HOST + 5 }, (_, i) =>
      rule({ id: "r" + i, host: "example.com" }),
    );
    const mine = [...many, rule({ id: "mine" })];
    expect(armedRulesFor(mine, "https://ritual.com/")).toHaveLength(1);
    expect(armedRulesFor(mine, "https://example.com/")).toHaveLength(MAX_RULES_PER_HOST);
  });

  it("answers empty for junk input rather than throwing", () => {
    expect(armedRulesFor(null, "https://ritual.com/")).toEqual([]);
    expect(
      armedRulesFor([null, undefined, 3] as unknown as never[], "https://ritual.com/"),
    ).toEqual([]);
  });
});

describe("normalizeOverlayRule", () => {
  it("rebuilds a valid rule", () => {
    const out = normalizeOverlayRule(rule());
    expect(out).toMatchObject({ id: "r1", host: "ritual.com", label: "Close" });
    expect(out?.target).toEqual({ k: "testid", v: "dg-header-close" });
  });

  it("REBUILDS rather than filters — an unknown key never survives", () => {
    // The capture-boundary rule: spreading the input and overwriting known keys
    // carries every unknown key with it, so the next field wired into the
    // watcher would silently become a hole.
    const out = normalizeOverlayRule(rule({ evil: "payload", __proto__: { x: 1 } }));
    expect(out).not.toHaveProperty("evil");
    expect(Object.keys(out ?? {}).sort()).toEqual(
      ["createdAt", "host", "id", "label", "target", "updatedAt"].sort(),
    );
  });

  it("refuses an xpath target", () => {
    // Not a taste call. An absolute path encodes the DOM as it stood when the
    // rule was taught, and a third-party CMP's sibling index is exactly what
    // moves between a recording session and a fresh cache-less run.
    expect(normalizeOverlayRule(rule({ target: { k: "xpath", v: "/html/body/aside" } }))).toBeNull();
  });

  it("accepts every kind a rule may use, and nothing else", () => {
    for (const target of [
      { k: "css", v: "button.close" },
      { k: "testid", v: "x" },
      { k: "text", v: "Accept" },
      { k: "role", role: "button", name: "Close" },
    ]) {
      expect(normalizeOverlayRule(rule({ target })), JSON.stringify(target)).not.toBeNull();
    }
  });

  it("drops a context clause", () => {
    // A rule resolves against whatever document it lands on, so a container
    // recorded on one page is a narrowing that may not exist on the next — and
    // the watcher takes the first match, so a stale clause can only make it
    // miss.
    const out = normalizeOverlayRule(
      rule({ target: { k: "css", v: "button.close", ctx: { within: { k: "css", v: "#banner" } } } }),
    );
    expect(out?.target.ctx).toBeUndefined();
  });

  it("refuses a rule with no id, no host, or no usable target", () => {
    expect(normalizeOverlayRule(rule({ id: "" }))).toBeNull();
    expect(normalizeOverlayRule(rule({ host: "" }))).toBeNull();
    expect(normalizeOverlayRule(rule({ target: null }))).toBeNull();
    expect(normalizeOverlayRule(rule({ target: { k: "nonsense", v: "x" } }))).toBeNull();
    expect(normalizeOverlayRule("a string")).toBeNull();
    expect(normalizeOverlayRule(null)).toBeNull();
  });

  it("lowercases the host, so a rule taught on a capitalised URL still matches", () => {
    const out = normalizeOverlayRule(rule({ host: "WWW.Ritual.COM" }));
    expect(out?.host).toBe("www.ritual.com");
    expect(hostMatches(out!.host, "https://www.ritual.com/")).toBe(true);
  });

  it("caps the label", () => {
    const out = normalizeOverlayRule(rule({ label: "x".repeat(500) }));
    expect(out!.label.length).toBeLessThanOrEqual(120);
  });

  it("normalizes `disabled` to true-or-absent, never a truthy string", () => {
    expect(normalizeOverlayRule(rule({ disabled: "yes" }))?.disabled).toBeUndefined();
    expect(normalizeOverlayRule(rule({ disabled: true }))?.disabled).toBe(true);
  });
});

describe("overlayVisible", () => {
  // The watcher's gate. A CMP renders its banner and then reveals it, so
  // "present" and "visible" are different questions — and clicking a hidden
  // control is how a watcher fires once at document start, does nothing, and
  // never fires again.
  it("is false for a non-element", () => {
    expect(overlayVisible(null)).toBe(false);
    expect(overlayVisible({})).toBe(false);
  });
});
