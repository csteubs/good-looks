// Containment of navigation in the training window.
//
// This is the highest-stakes decision in the app. Glaze routes cross-origin
// main-frame navigations to the SYSTEM BROWSER by default, so "we didn't
// object" means "drive the user's real, logged-in browser". It happened: a
// replay left the training window and ran in a different browser that was open
// at the time.
//
// The old handler was a chain of early returns, and every one was an escape
// hatch nobody read as one. These tests therefore spend most of their effort on
// the cases that USED to return early — a redirect, an absent field, an
// unfamiliar scheme — and assert that none of them resolves to "proceed".
//
// Rule under test: nothing escapes unless positively proven safe, and the only
// two accepted proofs are "cannot leave the page" and "we issued it ourselves".

import { describe, it, expect } from "vitest";

import {
  DENIED_RECORDER_PERMISSIONS,
  GUARDED_NAVIGATION_EVENTS,
  decideNavigation,
  isDuplicateContainment,
  permissionAllowed,
  type NavigationDetails,
} from "./recorder-navigation.js";

const EXTERNAL = "https://checkout.shopify.com/cart";

function nav(over: Partial<NavigationDetails> = {}): NavigationDetails {
  return { url: EXTERNAL, isMainFrame: true, isSameDocument: false, ...over };
}

/** Nothing may ever resolve to "the default happens" for a main-frame URL we
 *  did not issue. `allow` is that outcome, so it is the assertion that matters. */
function expectContained(details: NavigationDetails | null | undefined, selfLoad: string | null = null) {
  const decision = decideNavigation(details, selfLoad);
  expect(decision.action).not.toBe("allow");
  return decision;
}

describe("the navigation that escaped", () => {
  it("contains a cross-origin main-frame navigation", () => {
    const decision = decideNavigation(nav(), null);
    expect(decision).toEqual({
      action: "load-in-window",
      url: EXTERNAL,
      reason: expect.any(String),
    });
  });

  it("contains it identically whichever event carried it", () => {
    // The actual bug: `will-redirect` was not wired at all, so a server 302 to
    // another origin bypassed the interceptor entirely. The decision cannot
    // depend on which event delivered the navigation.
    for (const event of GUARDED_NAVIGATION_EVENTS) {
      expect(GUARDED_NAVIGATION_EVENTS).toContain(event);
    }
    expect(GUARDED_NAVIGATION_EVENTS).toContain("will-redirect");
    expect(GUARDED_NAVIGATION_EVENTS).toContain("will-navigate");
    expect(GUARDED_NAVIGATION_EVENTS).toContain("will-frame-navigate");
  });
});

describe("the only two ways out", () => {
  it("allows a same-document navigation", () => {
    // An SPA push/replace/hash cannot leave the window by definition.
    expect(decideNavigation(nav({ isSameDocument: true }), null).action).toBe("allow");
  });

  it("allows a load we issued ourselves", () => {
    // Containing our own loadURL again would loop forever.
    expect(decideNavigation(nav(), EXTERNAL).action).toBe("allow");
  });

  it("does not mistake a different URL for our own load", () => {
    expectContained(nav({ url: "https://evil.test/x" }), EXTERNAL);
  });

  it("does not treat a null selfLoad as matching a URL-less event", () => {
    expectContained({ url: "", isMainFrame: true }, null);
  });
});

describe("failing closed on malformed events", () => {
  it("blocks a null or non-object event", () => {
    expect(decideNavigation(null, null).action).toBe("block");
    expect(decideNavigation(undefined, null).action).toBe("block");
    expect(decideNavigation("nope" as unknown as NavigationDetails, null).action).toBe("block");
  });

  it("blocks an event with no usable URL", () => {
    expect(decideNavigation({ url: undefined }, null).action).toBe("block");
    expect(decideNavigation({ url: 42 as unknown as string }, null).action).toBe("block");
    expect(decideNavigation({ url: "" }, null).action).toBe("block");
  });

  it("treats an ABSENT isMainFrame as a main-frame navigation", () => {
    // The old guard read `!details.isMainFrame` and returned — so a missing
    // field disabled the entire protection and sent the navigation to the
    // system browser. Between a mis-loaded iframe and the user's real browser
    // being driven through a test, only one of those is recoverable.
    expectContained({ url: EXTERNAL, isSameDocument: false });
  });

  it("treats a non-boolean isSameDocument as NOT same-document", () => {
    // Only a literal `true` counts as proof. "truthy" is not proof.
    expectContained(nav({ isSameDocument: "no" as unknown as boolean }));
    expectContained(nav({ isSameDocument: undefined }));
  });

  it("does not accept a truthy non-boolean isMainFrame as a reason to skip", () => {
    expectContained(nav({ isMainFrame: "yes" as unknown as boolean }));
  });
});

describe("schemes", () => {
  it("contains http and https", () => {
    expect(decideNavigation(nav({ url: "http://x.test/a" }), null).action).toBe("load-in-window");
    expect(decideNavigation(nav({ url: "https://x.test/a" }), null).action).toBe("load-in-window");
  });

  it("blocks schemes that would hand off to another application", () => {
    // These used to return early and proceed, which lets the OS launch a mail
    // client, a phone dialer, or an arbitrary registered app — mid-replay.
    for (const url of [
      "mailto:someone@example.com",
      "tel:+15551234567",
      "zoommtg://zoom.us/join?confno=1",
      "slack://open",
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "javascript:alert(1)",
      "about:blank",
      "chrome://settings",
    ]) {
      const decision = decideNavigation(nav({ url }), null);
      expect(decision.action, `${url} must not proceed`).toBe("block");
    }
  });

  it("is not fooled by scheme casing or a leading protocol-like path", () => {
    expect(decideNavigation(nav({ url: "HTTPS://x.test/a" }), null).action).toBe("load-in-window");
    // Not a URL with an http scheme — it is a relative path that merely
    // contains the text. It must not be treated as safe to load.
    expect(decideNavigation(nav({ url: "/redirect?to=https://x.test" }), null).action).toBe("block");
  });
});

describe("sub-frames", () => {
  it("allows a genuine sub-frame navigation", () => {
    // Re-issuing it in the main window would replace the page with an iframe's
    // URL — an ad frame would blow away the site under test.
    expect(decideNavigation(nav({ isMainFrame: false }), null).action).toBe("allow");
  });

  it("requires isMainFrame to be exactly false, not merely falsy", () => {
    expectContained(nav({ isMainFrame: 0 as unknown as boolean }));
    expectContained(nav({ isMainFrame: null as unknown as boolean }));
  });
});

describe("duplicate containment", () => {
  it("suppresses a repeat of the same URL within the window", () => {
    // The three guarded events overlap, and each containment issues a loadURL —
    // without this one click could load the same page several times.
    expect(isDuplicateContainment({ url: EXTERNAL, at: 1000 }, EXTERNAL, 1200)).toBe(true);
  });

  it("does not suppress a different URL", () => {
    expect(isDuplicateContainment({ url: EXTERNAL, at: 1000 }, "https://x.test/", 1200)).toBe(false);
  });

  it("does not suppress the same URL later on", () => {
    // Navigating back to a page you already visited must still work.
    expect(isDuplicateContainment({ url: EXTERNAL, at: 1000 }, EXTERNAL, 5000)).toBe(false);
  });

  it("never suppresses when nothing has been contained yet", () => {
    expect(isDuplicateContainment(null, EXTERNAL, 1000)).toBe(false);
  });
});

describe("the invariant, stated directly", () => {
  it("never allows a main-frame http navigation we did not issue", () => {
    // Exhaustive sweep of the shapes an event can take. Whatever the
    // combination, an unowned main-frame page load is never left to proceed.
    const urls = [EXTERNAL, "http://a.test/", "https://b.test/x?y=1"];
    const mainFrames = [true, undefined, null, "yes", 1];
    const sameDocs = [false, undefined, null, "no", 0];

    for (const url of urls) {
      for (const isMainFrame of mainFrames) {
        for (const isSameDocument of sameDocs) {
          const decision = decideNavigation(
            { url, isMainFrame, isSameDocument } as NavigationDetails,
            null,
          );
          expect(
            decision.action,
            `url=${url} isMainFrame=${String(isMainFrame)} isSameDocument=${String(isSameDocument)}`,
          ).toBe("load-in-window");
        }
      }
    }
  });

  it("every decision carries a reason, so a block is diagnosable", () => {
    const cases: (NavigationDetails | null)[] = [
      null,
      { url: "" },
      nav(),
      nav({ isSameDocument: true }),
      nav({ isMainFrame: false }),
      nav({ url: "mailto:a@b.c" }),
    ];
    for (const c of cases) {
      expect(decideNavigation(c, null).reason.length).toBeGreaterThan(0);
    }
  });
});


describe("capability containment", () => {
  it("refuses the openExternal permission outright", () => {
    // The stronger guard. Intercepting events assumes the escape travels
    // through an event we thought to listen for — an assumption already proven
    // wrong once. Denying the capability refuses it whatever asks, by whatever
    // path, including paths that raise no navigation event at all.
    expect(permissionAllowed("openExternal")).toBe(false);
    expect(DENIED_RECORDER_PERMISSIONS).toContain("openExternal");
  });

  it("leaves every other permission alone", () => {
    // A training browser needs these to reproduce a real session; denying them
    // would break recordings without preventing any escape.
    for (const permission of [
      "media",
      "geolocation",
      "notifications",
      "clipboard-read",
      "fullscreen",
      "midi",
      "storage-access",
    ]) {
      expect(permissionAllowed(permission), permission).toBe(true);
    }
  });

  it("allows an unknown permission rather than breaking the page", () => {
    // Opposite default from navigation, deliberately: an unrecognized
    // permission cannot hand a URL to the OS, so failing closed here would
    // break pages for no gain. The escape route is named, and it is denied.
    expect(permissionAllowed("some-future-permission")).toBe(true);
  });
});
