// The Shopify crawler-signature fixture, as a raw JS string written next to the
// specs at runtime (like settle-fixture-source.ts and heal-fixture-source.ts).
//
// What it does
// ------------
// Attaches the three signature headers to requests bound for a host the user
// registered a signature for, and to nothing else.
//
// Why a route and not `use.extraHTTPHeaders`
// ------------------------------------------
// `extraHTTPHeaders` is CONTEXT-WIDE. A Shopify storefront contacts
// cdn.shopify.com, monorail-edge.shopifysvc.com, Google Analytics, Klaviyo, the
// Meta pixel and whatever apps the merchant installed, and every one of them
// would receive a credential that lets its holder crawl the store past bot
// protection until it expires. Routing is the only place in Playwright where
// a header can be decided per request.
//
// It is also the technically correct answer, not just the cautious one: the
// signature covers `@authority`, so presenting it at a host it was not issued
// for is an INVALID signature rather than a missing one — offered to a verifier
// whose job is spotting bot spoofing.
//
// What it costs
// -------------
// Enabling routing disables the browser's HTTP cache for the context. That
// changes timing, and on a visual-diffing app timing can move a screenshot —
// which is why the runner arms this only for a test whose own origin is
// registered, rather than for every run on a machine that has a signature.
//
// Why it is its own module rather than more code in the capture fixture
// --------------------------------------------------------------------
// Same reason settling is: it is independently gated, and keeping the network
// layer separate from the action-wrapping patches is what makes the install
// order below arguable at all. It is still INSTALLED from the capture fixture,
// because a spec imports exactly one module for `test`.
//
// Plain JavaScript (no TypeScript) because Playwright loads it through its own
// Babel transform.

export const SIGNATURE_FIXTURE_FILE = "glaze-signature.mjs";

/** Env var carrying how many signatures this run may present. The values
 *  themselves travel one variable each — never a JSON blob, which would show up
 *  whole in a crash dump or a process listing (the rule playwright-runner.ts
 *  states for `GLAZE_SECRET_*`). */
export const SIGNATURE_COUNT_ENV = "GLAZE_SIG_COUNT";

/** The env var names for signature `index`. One place, so the writer in
 *  playwright-runner.ts and the reader below cannot disagree. */
export function signatureEnvNames(index) {
  return {
    host: `GLAZE_SIG_${index}_HOST`,
    input: `GLAZE_SIG_${index}_INPUT`,
    value: `GLAZE_SIG_${index}_VALUE`,
    agent: `GLAZE_SIG_${index}_AGENT`,
  };
}

export const signatureFixtureSource = `const COUNT = Number(process.env.${SIGNATURE_COUNT_ENV} || 0);

/** host → { input, value, agent }, read once at module load. */
const ENTRIES = (function () {
  const out = new Map();
  for (let i = 0; i < COUNT; i++) {
    const host = String(process.env["GLAZE_SIG_" + i + "_HOST"] || "").toLowerCase();
    const input = process.env["GLAZE_SIG_" + i + "_INPUT"] || "";
    const value = process.env["GLAZE_SIG_" + i + "_VALUE"] || "";
    const agent = process.env["GLAZE_SIG_" + i + "_AGENT"] || "";
    if (host && input && value && agent) out.set(host, { input: input, value: value, agent: agent });
  }
  return out;
})();

const ON = ENTRIES.size > 0;

/** host → how many requests were signed. The whole point of counting: a run
 *  that arms a signature and signs ZERO requests is this feature's most likely
 *  silent failure, and it is otherwise indistinguishable from one that worked. */
const signed = new Map();

let installed = false;

/** Diagnostics go to STDERR, never stdout — stdout carries the StepReporter's
 *  markers, and text interleaved into that stream breaks step highlighting for
 *  the whole run. */
function note(message) {
  try { process.stderr.write("[glaze-signature] " + message + "\\n"); } catch (e) { /* ignore */ }
}

/**
 * Attach the signature headers to requests for a registered host.
 *
 * Installed FIRST, before healing and settling. Those two wrap action methods;
 * this one sits on the network layer, and it must not end up inside anybody's
 * action wrapper — a retry would otherwise re-enter it.
 */
export function installSignatureHeaders(page) {
  if (!ON || installed) return;
  installed = true;
  try {
    // ONE route with a predicate rather than one per host: the predicate is
    // exact (\`URL.host\`, which carries the port) where a glob would be
    // Playwright's own pattern language, and the whole question here is which
    // hosts do NOT get the header.
    page.context().route(
      function (url) {
        try { return ENTRIES.has(String(url.host).toLowerCase()); } catch (e) { return false; }
      },
      async function (route) {
        let entry = null;
        try {
          entry = ENTRIES.get(new URL(route.request().url()).host.toLowerCase()) || null;
        } catch (e) { entry = null; }
        if (!entry) {
          try { await route.continue(); } catch (e) { /* ignore */ }
          return;
        }
        try {
          // allHeaders(), not headers(): \`continue({headers})\` REPLACES the
          // header set, so anything missing from what we pass is dropped from
          // the request.
          const current = await route.request().allHeaders();
          const merged = Object.assign({}, current, {
            "signature-input": entry.input,
            "signature": entry.value,
            "signature-agent": entry.agent,
          });
          let host = "";
          try { host = new URL(route.request().url()).host.toLowerCase(); } catch (e) { host = ""; }
          await route.continue({ headers: merged });
          signed.set(host, (signed.get(host) || 0) + 1);
        } catch (err) {
          // Never fail a test over this. An unsigned request may well be
          // refused by the store — that is a legible failure — whereas a
          // rejected route aborts the request outright.
          //
          // The error is logged by NAME AND MESSAGE only. A stringified route
          // or request could carry the header values straight into the run log.
          note("could not sign a request: " + (err && err.name ? err.name : "Error") + ": " + (err && err.message ? err.message : ""));
          try { await route.continue(); } catch (e) { /* ignore */ }
        }
      },
    );
  } catch (err) {
    note("install failed: " + (err && err.message ? err.message : String(err)));
  }
}

/** Say how many requests were actually signed, per host. Called once per test
 *  from the capture fixture's teardown. */
export function reportSignedRequests() {
  if (!ON) return;
  for (const host of ENTRIES.keys()) {
    const count = signed.get(host) || 0;
    note("signed " + count + " request(s) to " + host);
  }
  signed.clear();
}
`;
