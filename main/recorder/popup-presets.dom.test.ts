/* Runs in the "dom" Vitest project (jsdom) but lives under main/, which the
   shared lint config treats as Node-only — hence the explicit globals. */
/* global Element, HTMLElement */

// Do the built-in pop-up handlers FIND the vendor's close control — and only
// the vendor's — when the real capture script is installed over the vendor's
// real markup?
//
// ── Why it is tested by RUNNING the script ─────────────────────────────────
// A preset is a CSS selector in shared/popup-presets.mjs, and a selector is
// only as right as what it resolves against. The unit test beside it
// (main/services/popup-presets.test.ts) proves the LIST is right — the switch,
// the disabled ids, the env round trip — and cannot say whether
// `button.dg-header-close` finds a button. The watcher that clicks it is a
// string interpolated into the trainer's capture script, resolving through the
// app's own `matchesFor`; a test that mocked either half would prove the preset
// is handed over, not that it lands. So this installs the REAL capture script
// through `captureHarness`, hands it the REAL armed list from
// `armedPopupRulesFor` (never a hand-written target — a target typed here is a
// second spelling of the preset, right today and silently stale tomorrow), and
// injects the vendor's markup from main/recorder/__fixtures__/vendor-popups.ts
// AFTER install, the way a timer-driven form and a per-document banner arrive.
//
// ── The jsdom half ─────────────────────────────────────────────────────────
// jsdom has no layout, so `getBoundingClientRect` is zeros and the watcher's
// visibility gate would treat every control as hidden; `makeVisible` gives the
// close control a nominal box, the way overlay-watcher.dom.test.ts does. What
// jsdom therefore cannot say is whether a real Klaviyo backdrop intercepts a
// click underneath it and whether the run's dismissal fixture clears it in
// time — that is e2e/popup-dismissal.spec.ts, the same fixture markup under
// real Playwright. Two halves, one fixture, on purpose.
//
// ── What the rows pin ──────────────────────────────────────────────────────
// A Klaviyo close is clicked ONCE across many sweeps (the real button stays in
// the DOM ~600ms after the click, which is how one dismissal once produced
// seven). A DataGrail close inside an OPEN SHADOW ROOT is reached, and a banner
// re-injected on the next document is clicked again. A look-alike Close button
// outside the vendor's markup is NOT clicked — the whole reason the presets are
// scoped to the vendor's container rather than being "a button named Close".
// The watcher's own click never becomes a step and the suppression counter
// comes back to zero. And the switch is honoured: off arms nothing, a preset
// switched off in Settings stays off while the other still fires.

import { describe, expect, it, vi } from "vitest";

import { DATAGRAIL_BANNER_SCRIPT, KLAVIYO_FORM_HTML } from "./__fixtures__/vendor-popups.js";
import { captureHarness } from "./capture-harness.js";
import type { ArmedOverlayRule } from "./types.js";
import type { OverlayRuleLike } from "../../shared/overlay-rules.mjs";
import { armedPopupRulesFor } from "../../shared/popup-presets.mjs";

type Harness = ReturnType<typeof captureHarness>;

/** The site the presets were measured against. A preset has no host — it
 *  applies wherever its vendor's markup is — so the URL only matters for the
 *  taught rule in the last row. */
const SITE = "https://www.ritual.com/";

/** What one trainer document arms, through the ONE function every arming
 *  site calls. Never a hand-written target. */
function armed(
  over: {
    rules?: OverlayRuleLike[];
    handlePopups?: boolean;
    disabledPresets?: string[];
  } = {},
): ArmedOverlayRule[] {
  return armedPopupRulesFor({
    rules: over.rules ?? [],
    url: SITE,
    handlePopups: over.handlePopups ?? true,
    disabledPresets: over.disabledPresets,
  }) as ArmedOverlayRule[];
}

/** A page with the real capture script AND the given armed list installed.
 *  Each test gets its own iframe window — see overlay-watcher.dom.test.ts for
 *  why a shared document would run one watcher per earlier test. */
function page(html: string, rules: readonly ArmedOverlayRule[]): Harness {
  return captureHarness(html, Date, rules);
}

/** jsdom lays nothing out, so `getBoundingClientRect` is zeros and the
 *  watcher's visibility gate would treat every element as hidden. Give the
 *  control a nominal box, the same way overlay-watcher.dom.test.ts does. */
function makeVisible(el: Element): void {
  el.getBoundingClientRect = () =>
    ({ width: 120, height: 32, top: 10, left: 10, right: 130, bottom: 42, x: 10, y: 10 }) as DOMRect;
}

/** Let the MutationObserver's microtask AND the watcher's release timer run —
 *  two turns, because the observer's click schedules the suppression release
 *  as a macrotask, and one `setTimeout(0)` queued before the mutation runs
 *  BEFORE that release. */
const settle = async () => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
};

const KLAVIYO_CLOSE = '[data-testid="klaviyo-form-VjKqWx"] button[aria-label="Close dialog"]';
const DATAGRAIL_HOST = "aside.dg-consent-banner";

/** Inject the Klaviyo form the way the vendor's script does — into a page the
 *  capture script is already installed on. The close button is NOT removed on
 *  click (the fixture leaves that to its consumer), which models the measured
 *  behaviour where the control outlives the click and the clicked-set is what
 *  keeps the count at one. */
function injectKlaviyo(p: Harness): HTMLElement {
  p.doc.body.insertAdjacentHTML("beforeend", KLAVIYO_FORM_HTML);
  const close = p.el(KLAVIYO_CLOSE);
  makeVisible(close);
  return close;
}

/** Install the DataGrail banner by running the fixture's OWN script against
 *  the harness document — the banner has an open shadow root, which cannot be
 *  written as HTML. Its close handler removes the banner and counts the click
 *  into `data-dg-closes` on `<html>`, so a row can assert "one click per node"
 *  rather than "at least one". */
function injectDataGrail(p: Harness): HTMLElement {
  new Function("document", DATAGRAIL_BANNER_SCRIPT)(p.doc);
  const host = p.el(DATAGRAIL_HOST);
  const close = host.shadowRoot?.querySelector(".dg-header-close") as HTMLElement | null;
  expect(close, "the banner's close control, inside its open shadow root").not.toBeNull();
  makeVisible(close as HTMLElement);
  return close as HTMLElement;
}

function dataGrailCloses(p: Harness): string | null {
  return p.doc.documentElement.getAttribute("data-dg-closes");
}

function recordedClicks(p: Harness) {
  return p.egress().filter((s) => s.type === "click");
}

describe("the built-in pop-up handlers, over the vendor's markup", () => {
  it("click a Klaviyo form's close control exactly once, however many times they sweep", async () => {
    const p = page("", armed());
    const close = injectKlaviyo(p);
    const clicked = vi.fn();
    close.addEventListener("click", clicked);
    await settle();
    expect(clicked).toHaveBeenCalledTimes(1);

    // The control is still in the DOM — exactly the Klaviyo case, where the
    // button is removed ~600ms after the click and the sweep runs on every
    // mutation batch in between.
    const form = p.el('[data-testid="klaviyo-form-VjKqWx"]');
    for (let i = 0; i < 6; i++) {
      form.appendChild(p.doc.createElement("span"));
      await settle();
    }
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("reach a DataGrail close control inside its open shadow root", async () => {
    const p = page("", armed());
    injectDataGrail(p);
    await settle();
    // Counted by the vendor's own handler, and the banner it removes is gone.
    expect(dataGrailCloses(p)).toBe("1");
    expect(p.doc.querySelector(DATAGRAIL_HOST)).toBeNull();
  });

  it("click a re-injected DataGrail banner again, because a new document's banner is a new element", async () => {
    const p = page("", armed());
    injectDataGrail(p);
    await settle();
    expect(dataGrailCloses(p)).toBe("1");

    // The consent script runs on EVERY document; the next page has a fresh
    // banner, and node identity rather than a per-rule flag is what lets the
    // watcher click it.
    injectDataGrail(p);
    await settle();
    expect(dataGrailCloses(p)).toBe("2");
    expect(p.doc.querySelector(DATAGRAIL_HOST)).toBeNull();
  });

  it("leave a look-alike Close button OUTSIDE the vendor's markup alone", async () => {
    // A site's own dialog with the same accessible name, and a site's own
    // banner with a similar class — neither inside a Klaviyo container, neither
    // carrying DataGrail's `dg-` markup. A bare "button named Close" rule would
    // click both, on every page.
    const p = page(
      `<div id="site">
         <div role="dialog" aria-modal="true"><button id="site-close" aria-label="Close dialog">×</button></div>
         <aside class="consent-banner"><button id="site-header-close" class="header-close" aria-label="Close">×</button></aside>
       </div>`,
      armed(),
    );
    const siteClose = p.el("#site-close");
    const siteHeaderClose = p.el("#site-header-close");
    makeVisible(siteClose);
    makeVisible(siteHeaderClose);
    const clicked = vi.fn();
    siteClose.addEventListener("click", clicked);
    siteHeaderClose.addEventListener("click", clicked);

    p.el("#site").appendChild(p.doc.createElement("span"));
    await settle();
    expect(clicked).not.toHaveBeenCalled();
  });

  it("never record their own click as a step, and leave capture working afterwards", async () => {
    // The watcher runs in the same isolated world as the capture listeners, so
    // its click reaches them exactly like a user's. Unsuppressed, a Klaviyo
    // dismissal would be appended to the test being recorded — a step whose
    // target the preset itself removes before it can run. And a LEAKED
    // suppression is worse: every later click would vanish with no error.
    const p = page(`<button data-testid="buy">Buy</button>`, armed());
    injectKlaviyo(p);
    injectDataGrail(p);
    await settle();
    expect(dataGrailCloses(p)).toBe("1");
    expect(recordedClicks(p)).toHaveLength(0);
    expect(p.overlaySuppress()).toBe(0);

    p.click('[data-testid="buy"]');
    const clicks = recordedClicks(p);
    expect(clicks).toHaveLength(1);
    expect(clicks[0].locator).toMatchObject({ k: "testid", v: "buy" });
  });

  it("arm NOTHING when Handle pop-ups is off, so the vendor's markup stays", async () => {
    const rules = armed({ handlePopups: false });
    expect(rules).toEqual([]);
    const p = page("", rules);
    const close = injectKlaviyo(p);
    const clicked = vi.fn();
    close.addEventListener("click", clicked);
    injectDataGrail(p);
    await settle();
    expect(clicked).not.toHaveBeenCalled();
    expect(dataGrailCloses(p)).toBeNull();
    expect(p.doc.querySelector(DATAGRAIL_HOST)).not.toBeNull();
    expect(p.overlaySuppress()).toBe(0);
  });

  it("keep a preset switched off in Settings off while the other still fires", async () => {
    const p = page("", armed({ disabledPresets: ["klaviyo-form-close"] }));
    const close = injectKlaviyo(p);
    const clicked = vi.fn();
    close.addEventListener("click", clicked);
    injectDataGrail(p);
    await settle();
    expect(clicked).not.toHaveBeenCalled();
    expect(dataGrailCloses(p)).toBe("1");
  });

  it("click a control ONCE when a taught rule and a preset both name it", async () => {
    // A rule taught on ritual.com before the presets shipped points at the
    // same DataGrail close. Both are armed — the taught rule first — and the
    // clicked-set is by node identity, so the preset behind it never clicks
    // the node a second time.
    const taught: OverlayRuleLike = {
      id: "r1",
      host: "ritual.com",
      label: "Cookie banner — Close",
      target: { k: "css", v: "button.dg-header-close" },
    };
    const rules = armed({ rules: [taught] });
    expect(rules.map((r) => r.id)[0]).toBe("r1");
    expect(rules.length).toBeGreaterThan(1);
    const p = page("", rules);
    injectDataGrail(p);
    await settle();
    expect(dataGrailCloses(p)).toBe("1");
  });
});
