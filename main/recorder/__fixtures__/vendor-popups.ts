// Synthetic Klaviyo and DataGrail markup — the two vendors the built-in pop-up
// handlers (shared/popup-presets.mjs) ship for, reproduced from the evidence
// this repo recorded on ritual.com so the presets can be exercised without the
// network.
//
// ONE fixture, TWO consumers, and that is the point. The jsdom test
// (main/recorder/popup-presets.dom.test.ts) proves the trainer's watcher
// resolves each preset against this markup through the app's own locator
// engine; e2e/popup-dismissal.spec.ts proves real Playwright and the run's
// dismissal fixture do, with layout — the same question assert-parity asks,
// one level down. Two hand-copies of "what a Klaviyo form looks like" would be
// two fixtures that each pass while describing different markup, which is how
// a preset ends up right in the test and wrong on the site.
//
// NO IMPORTS, deliberately: the dom project loads this through Vite and the
// e2e spec through Playwright's own transform, and a bare module is the one
// shape both accept without an alias table between them.
//
// What is measured and what is modelled:
//  • KLAVIYO renders an in-page `div[role="dialog"][aria-modal="true"]`
//    carrying class and data-testid `klaviyo-form-<id>`, every element
//    `needsclick`, and a close control whose accessible name ritual.com spells
//    "Close dialog". The close button is REMOVED ~600ms AFTER the click
//    (DECISIONS 2026-08-22: one dismissal produced seven clicks before the
//    watcher's clicked-set existed), and the modal sits at z-index 90000 over
//    a full-viewport backdrop — which is what makes a click underneath it fail
//    with "intercepts pointer events".
//  • DATAGRAIL injects `<aside class="dg-consent-banner">` with an OPEN shadow
//    root on EVERY document, `dg-` prefixed controls (`button.dg-button
//    .accept_all` was measured on ritual.com) and a header close control the
//    vendor documents as `.dg-header-close`; this repo's fixtures also recorded
//    a `data-testid` of the same name, and the banner carries both. A shadow
//    root cannot be written as HTML, so the banner is a SCRIPT that builds it.

/**
 * A Klaviyo pop-up form as ritual.com renders one: the vendor's container
 * (class + test id `klaviyo-form-<id>`, dialog role, modal), a full-viewport
 * backdrop at z-index 90000, and the "Close dialog" button. Static HTML — the
 * close behaviour (removal 600ms after the click) is wired by whoever injects
 * it, because the DOM test wants to count clicks and the e2e site wants the
 * measured delay.
 */
export const KLAVIYO_FORM_HTML = `<div class="klaviyo-form-VjKqWx klaviyo-form" data-testid="klaviyo-form-VjKqWx" role="dialog" aria-modal="true" aria-label="POPUP Form" style="position:fixed;top:0;left:0;right:0;bottom:0;z-index:90000">
  <div class="needsclick kl-private-backdrop" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.55);z-index:90000"></div>
  <div class="needsclick kl-private-form" style="position:fixed;top:15%;left:50%;width:320px;margin-left:-160px;padding:32px 24px 24px;background:#fff;z-index:90001">
    <button class="needsclick" type="button" aria-label="Close dialog" style="position:absolute;top:8px;right:8px;width:32px;height:32px;border:0;background:transparent;font-size:20px;cursor:pointer">×</button>
    <h2 class="needsclick">Get 10% off your first order</h2>
    <input class="needsclick" type="email" placeholder="Email address" />
    <button class="needsclick" type="button">Subscribe</button>
  </div>
</div>`;

/**
 * A script that installs a DataGrail consent banner into `document`: the
 * `aside.dg-consent-banner` host, an OPEN shadow root holding the heading, the
 * Accept All / Manage Cookies buttons and the header close control. The close
 * control removes the banner IMMEDIATELY and counts the click into
 * `data-dg-closes` on `<html>`, so a consumer can prove "one click per node"
 * rather than "at least one click".
 *
 * A string rather than a function because it runs in three places that share
 * no scope: `new Function("document", …)` in the jsdom harness, and inline in
 * the e2e site's own `<script>` on every document it serves. `document` is the
 * one free name.
 */
export const DATAGRAIL_BANNER_SCRIPT = `(function () {
  var aside = document.createElement("aside");
  aside.className = "dg-consent-banner";
  var root = aside.attachShadow({ mode: "open" });
  root.innerHTML =
    "<style>" +
    ".dg-banner{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;padding:16px 24px;background:#f5f5f5;border-top:1px solid #ccc;font-family:sans-serif}" +
    ".dg-header{display:flex;justify-content:space-between;align-items:center}" +
    ".dg-header-close{width:32px;height:32px;border:0;background:transparent;font-size:20px;cursor:pointer}" +
    ".dg-button{margin-right:8px;padding:8px 16px}" +
    "</style>" +
    '<div class="dg-banner">' +
    '<div class="dg-header"><h2 class="dg-heading">We value your privacy</h2>' +
    '<button class="dg-header-close" type="button" aria-label="Close" data-testid="dg-header-close">×</button></div>' +
    '<p class="dg-body">We use cookies to improve your experience.</p>' +
    '<div class="dg-actions"><button class="dg-button accept_all" type="button">Accept All</button>' +
    '<button class="dg-button" type="button">Manage Cookies</button></div>' +
    "</div>";
  root.querySelector(".dg-header-close").addEventListener("click", function () {
    var html = document.documentElement;
    var n = Number(html.getAttribute("data-dg-closes")) || 0;
    html.setAttribute("data-dg-closes", String(n + 1));
    if (aside.parentNode) aside.parentNode.removeChild(aside);
  });
  document.body.appendChild(aside);
})();`;

/**
 * A whole page for the e2e site, served for every path: a Buy button that
 * sets the title to "bought", a link to /two (which serves the same page, so
 * the banner returns on the next document), the DataGrail banner installed
 * IMMEDIATELY on every document, and the Klaviyo form injected after
 * `klaviyoDelayMs` with its backdrop covering the Buy button. The Klaviyo
 * close handler removes the modal 600ms AFTER the click — the measured
 * behaviour — and counts each close into `data-klaviyo-closes` on `<html>`.
 */
export function popupSiteHtml({ klaviyoDelayMs = 1500 }: { klaviyoDelayMs?: number } = {}): string {
  const delay = Math.max(0, Math.round(klaviyoDelayMs));
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Popups | Acme</title>
<style>body{margin:0;font-family:sans-serif} main{padding:24px} button{padding:8px 16px}</style>
</head>
<body>
<main>
  <h1>Products</h1>
  <button data-testid="buy" type="button">Buy</button>
  <p><a href="/two" data-testid="next">Page two</a></p>
</main>
<script>
  document.querySelector('[data-testid="buy"]').addEventListener("click", function () {
    document.title = "bought";
  });
  ${DATAGRAIL_BANNER_SCRIPT}
  var KLAVIYO_FORM = ${JSON.stringify(KLAVIYO_FORM_HTML)};
  setTimeout(function () {
    var holder = document.createElement("div");
    holder.innerHTML = KLAVIYO_FORM;
    var modal = holder.firstElementChild;
    modal.querySelector('button[aria-label="Close dialog"]').addEventListener("click", function () {
      var html = document.documentElement;
      var n = Number(html.getAttribute("data-klaviyo-closes")) || 0;
      html.setAttribute("data-klaviyo-closes", String(n + 1));
      setTimeout(function () {
        if (modal.parentNode) modal.parentNode.removeChild(modal);
      }, 600);
    });
    document.body.appendChild(modal);
  }, ${delay});
</script>
</body></html>`;
}
