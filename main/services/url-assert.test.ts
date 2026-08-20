// What a URL assertion gets pre-filled with.
//
// Lives under `main/` so it runs in the node project — `shared/url-assert.mjs` has
// no DOM dependency and three callers on both sides of the IPC boundary (the
// training browser's URL strip, its right-click menu, and both trainers' assert
// menus). The value this returns becomes a line of generated Playwright, so
// "roughly right" is not a category here: a prefill the user does not notice is
// wrong ships as a passing assertion that tests nothing.

import { describe, expect, it } from "vitest";

import { urlAssertPrefill } from "../../shared/url-assert.mjs";

describe("urlAssertPrefill", () => {
  it("gives `urlIs` the whole absolute URL", () => {
    // `urlIs` generates `toHaveURL(/^…$/)` — an exact whole-URL match. Anything
    // short of the origin can never pass, so a path here would prefill a value
    // guaranteed to fail.
    expect(urlAssertPrefill("urlIs", "https://ritual.com/products/multivitamin")).toBe(
      "https://ritual.com/products/multivitamin",
    );
  });

  it("gives the substring kinds the path, not the origin", () => {
    // The whole reason `url` and `urlEndsWith` exist beside `urlIs`: the origin
    // is what differs between staging and production, so a spec asserting
    // `https://ritual.com/cart` fails on staging for a reason that has nothing
    // to do with the product.
    for (const kind of ["url", "urlEndsWith"]) {
      expect(urlAssertPrefill(kind, "https://ritual.com/cart?step=2")).toBe("/cart?step=2");
    }
  });

  it("keeps the query and the fragment", () => {
    // Both routinely carry the state the assertion is about — a checkout step, a
    // filtered list, an SPA route behind a hash.
    expect(urlAssertPrefill("url", "https://shop.test/search?q=iron#results")).toBe(
      "/search?q=iron#results",
    );
  });

  it("gives `urlPathIs` the pathname alone — the query is the noise it exists to ignore", () => {
    // The whole point of the kind: the value it seeds must survive the
    // `?variant=` and `utm_*` that differ between the recording and the run.
    expect(urlAssertPrefill("urlPathIs", "https://ritual.com/cart?step=2#top")).toBe("/cart");
    expect(
      urlAssertPrefill("urlPathIs", "https://ritual.com/products/synbiotic?variant=42283036246110"),
    ).toBe("/products/synbiotic");
  });

  it("gives `urlPathIs` the root path at a site root — exact match makes `/` safe", () => {
    // Unlike the contains kinds below, "path is /" is a true and falsifiable
    // statement about the page: it fails the moment the test is anywhere else.
    expect(urlAssertPrefill("urlPathIs", "https://ritual.com/")).toBe("/");
    expect(urlAssertPrefill("urlPathIs", "https://ritual.com")).toBe("/");
  });

  it("falls back to the host at the site root rather than suggesting `/`", () => {
    // THE ONE THAT MATTERS MOST. `toHaveURL("/")` is satisfied by every URL on
    // every host, so prefilling it would generate an assertion that passes
    // unconditionally — the most expensive kind of wrong, because it is green
    // and nobody looks at it again.
    expect(urlAssertPrefill("url", "https://ritual.com/")).toBe("ritual.com");
    expect(urlAssertPrefill("url", "https://ritual.com")).toBe("ritual.com");
    // The host keeps its port, which is what distinguishes two local services.
    expect(urlAssertPrefill("urlEndsWith", "http://127.0.0.1:5199/")).toBe("127.0.0.1:5199");
  });

  it("suggests nothing rather than something wrong", () => {
    // An empty field the user knows to fill in beats a plausible value they do
    // not check. `about:blank`'s pathname is the string "blank", which would
    // read like a typo in a generated spec.
    expect(urlAssertPrefill("url", "about:blank")).toBe("");
    expect(urlAssertPrefill("url", "data:text/html,<p>hi</p>")).toBe("");
    expect(urlAssertPrefill("url", "not a url")).toBe("");
    expect(urlAssertPrefill("url", "")).toBe("");
    // A kind this helper does not seed — `title` shares the dialog's field but
    // has nothing to do with the location.
    expect(urlAssertPrefill("title", "https://ritual.com/cart")).toBe("");
  });

  it("does not throw on the values a live page can actually produce", () => {
    // Called from a `did-navigate` handler and from a native menu builder, both
    // of which run while the page is mid-flight. A throw in either takes down
    // something the user is watching.
    for (const value of [undefined, null, 42, {}, []] as unknown[]) {
      expect(() => urlAssertPrefill("url", value as string)).not.toThrow();
      expect(urlAssertPrefill("url", value as string)).toBe("");
    }
  });
});
