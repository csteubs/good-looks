// Standalone check for the console/network capture helpers.
//
// These run INSIDE the Playwright process, from a string written to disk, so
// they cannot be imported and unit-tested normally. This check evaluates THE
// EXACT STRING that ships (LOG_CAPTURE_HELPERS) — testing a re-implementation
// would defeat the point, since the whole risk is that the shipped copy differs
// from the tested one.
//
// What matters here, in order of how badly it fails:
//   - credentials never reach disk (header allowlist, masked query params);
//   - the allowlist FAILS CLOSED, so an unknown header is elided, not kept;
//   - an elided header is still reported BY NAME, so a gap is visible;
//   - the caps bound a pathological run without silently losing the count.
//
// Run with: npm run check:log-capture

import {
  ELIDED,
  HEADER_ALLOWLIST,
  LOG_CAPTURE_HELPERS,
  MAX_TEXT_CHARS,
} from "../../../shared/log-capture-source.mjs";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// Evaluate the shipped helper source and hand back its functions.
const helpers = new Function(
  `${LOG_CAPTURE_HELPERS}\nreturn { glazeFilterHeaders, glazeScrubUrl, glazeTruncate, glazeMakeStore, glazePush, glazeDrain };`,
)() as {
  glazeFilterHeaders: (h: Record<string, string>, allowAll: boolean) => Record<string, string>;
  glazeScrubUrl: (url: string) => string;
  glazeTruncate: (s: string) => string;
  glazeMakeStore: () => { head: unknown[]; tail: unknown[]; dropped: number };
  glazePush: (store: unknown, entry: unknown, head: number, tail: number) => void;
  glazeDrain: (store: unknown) => { entries: unknown[]; dropped: number };
};

const { glazeFilterHeaders, glazeScrubUrl, glazeTruncate, glazeMakeStore, glazePush, glazeDrain } =
  helpers;

// ── Header allowlist ─────────────────────────────────────────────────
{
  const filtered = glazeFilterHeaders(
    {
      "Content-Type": "application/json",
      Authorization: "Bearer sk-live-abc123",
      Cookie: "session=deadbeef",
      "cache-control": "no-store",
      "X-Company-Internal-Token": "t0ps3cret",
    },
    false,
  );

  assert(filtered["content-type"] === "application/json", "an allowlisted header keeps its value");
  assert(filtered["cache-control"] === "no-store", "…and so does another");
  assert(filtered["authorization"] === ELIDED, "Authorization is elided");
  assert(filtered["cookie"] === ELIDED, "Cookie is elided");
  assert(
    filtered["x-company-internal-token"] === ELIDED,
    "an UNKNOWN header is elided — the allowlist fails closed",
  );
  assert(
    Object.keys(filtered).indexOf("authorization") >= 0,
    "an elided header is still reported by NAME, so its presence stays visible",
  );
  assert(
    JSON.stringify(filtered).indexOf("sk-live-abc123") < 0 &&
      JSON.stringify(filtered).indexOf("deadbeef") < 0 &&
      JSON.stringify(filtered).indexOf("t0ps3cret") < 0,
    "no elided value survives anywhere in the output",
  );
  assert(
    glazeFilterHeaders({ Authorization: "Bearer x" }, false)["authorization"] === ELIDED,
    "header matching is case-insensitive",
  );
}

{
  // The explicit escape hatch: the user asked for everything and gets it.
  const all = glazeFilterHeaders({ Authorization: "Bearer keep-me" }, true);
  assert(all["authorization"] === "Bearer keep-me", "allowAll records the real value");
}

{
  // …with exactly one exception, and this is the assertion that pins it. The
  // Shopify crawler signature is a credential THIS APP injected, and the
  // artifact it would land in is read back into the Visual tab and fed to a
  // hosted LLM by Debug with AI. `recordAllHeaders` is the user's opt-out for
  // headers the PAGE sends; it does not reach these.
  //
  // The bug this is written against is a one-token ordering change — moving the
  // never-list test to the far side of the `allowAll ||` — which is completely
  // silent, so it is driven with allowAll BOTH ways.
  for (const allowAll of [true, false]) {
    const filtered = glazeFilterHeaders(
      {
        "Signature-Input": 'sig1=("@authority");expires=1;keyid="k"',
        Signature: "sig1=:c2VjcmV0:",
        "Signature-Agent": '"https://shopify.com"',
        "content-type": "text/html",
      },
      allowAll,
    );
    for (const name of ["signature-input", "signature", "signature-agent"]) {
      assert(filtered[name] === ELIDED, `${name} is elided with allowAll=${allowAll}`);
    }
    assert(
      Object.keys(filtered).indexOf("signature") >= 0,
      `…while still being reported by name (allowAll=${allowAll})`,
    );
    assert(
      JSON.stringify(filtered).indexOf("c2VjcmV0") < 0,
      `no part of the signature value survives (allowAll=${allowAll})`,
    );
  }
}

{
  assert(glazeFilterHeaders({} as Record<string, string>, false) !== null, "empty headers are fine");
  assert(
    Object.keys(glazeFilterHeaders(null as unknown as Record<string, string>, false)).length === 0,
    "null headers produce an empty object rather than throwing",
  );
  assert(
    HEADER_ALLOWLIST.every((h) => h === h.toLowerCase()),
    "the allowlist itself is lowercase, or matching would silently miss entries",
  );
}

// ── URL scrubbing ────────────────────────────────────────────────────
{
  assert(
    glazeScrubUrl("https://x.test/a/b") === "https://x.test/a/b",
    "a URL with no query is untouched",
  );
  assert(
    glazeScrubUrl("https://x.test/a?page=2&q=shoes") === "https://x.test/a?page=2&q=shoes",
    "ordinary query parameters survive — they are what makes a log readable",
  );

  const scrubbed = glazeScrubUrl("https://x.test/cb?code=abc&access_token=xyz&page=2");
  assert(scrubbed.indexOf("abc") < 0, "an auth code value is masked");
  assert(scrubbed.indexOf("xyz") < 0, "an access_token value is masked");
  assert(scrubbed.indexOf("page=2") >= 0, "…while the harmless parameter is kept");
  assert(scrubbed.indexOf("code=") >= 0, "the parameter NAME survives, so the shape is visible");

  assert(
    glazeScrubUrl("https://x.test/a?TOKEN=abc").indexOf("abc") < 0,
    "parameter matching is case-insensitive",
  );
  assert(
    glazeScrubUrl("https://x.test/a?api_key=k#frag").indexOf("#frag") >= 0,
    "a fragment is preserved",
  );
  assert(glazeScrubUrl("https://x.test/a?api_key=k#frag").indexOf("=k") < 0, "…and the key masked");
  assert(glazeScrubUrl("") === "", "an empty URL is handled");
  assert(
    glazeScrubUrl(null as unknown as string) === "",
    "a null URL produces an empty string rather than 'null'",
  );
}

// ── Truncation ───────────────────────────────────────────────────────
{
  const long = "x".repeat(MAX_TEXT_CHARS + 500);
  const out = glazeTruncate(long);
  assert(out.length <= MAX_TEXT_CHARS + 1, "a huge console message is truncated");
  assert(out.endsWith("…"), "…and marked as truncated rather than silently cut");
  assert(glazeTruncate("short") === "short", "a short message is untouched");
}

// ── Head + tail store ────────────────────────────────────────────────
{
  const store = glazeMakeStore();
  for (let i = 0; i < 1000; i++) glazePush(store, { i }, 10, 20);
  const drained = glazeDrain(store) as { entries: { i: number }[]; dropped: number };

  assert(drained.entries.length === 30, "the store is bounded to head + tail");
  assert(drained.dropped === 970, "…and reports exactly how many it dropped");
  assert(drained.entries[0].i === 0, "the START of the run is kept (the page load)");
  assert(
    drained.entries[drained.entries.length - 1].i === 999,
    "the END of the run is kept (where the failure is)",
  );
  assert(
    drained.entries.slice(0, 10).every((e, i) => e.i === i),
    "the head is the first N in order",
  );
}

{
  const small = glazeMakeStore();
  for (let i = 0; i < 5; i++) glazePush(small, { i }, 10, 20);
  const drained = glazeDrain(small) as { entries: unknown[]; dropped: number };
  assert(drained.entries.length === 5 && drained.dropped === 0, "an under-cap run drops nothing");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll log-capture checks passed");
