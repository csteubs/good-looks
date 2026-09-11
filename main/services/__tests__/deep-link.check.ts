// Standalone regression check for `goodlooks://` links.
//
// A DEEP LINK IS UNTRUSTED INPUT in exactly the sense a branch name from a pull
// request head ref is: the URL sits in a Linear issue that anyone in the
// workspace can edit, and it is clicked by whoever opens that issue. It then
// arrives at the app with the authority of "the user clicked it".
//
// This pins three properties, in order of how badly each fails:
//
//   1. Nothing traverses. Ids from a link are used to look records up, and a
//      lookup key that can hold `..` or a separator is one refactor away from
//      being a path. Encoded forms are refused too — `%2e%2e` decodes to `..`
//      and a validator that checks before decoding proves nothing.
//   2. Nothing is guessed. An unparseable link resolves to NOTHING rather than
//      to a default route: silently landing somewhere plausible is how a
//      malformed link gets reported as "the app ignored my click", and a
//      fallback route is also what turns a hostile link into a navigation.
//   3. Build and parse agree. They are used by different processes, so a
//      disagreement produces links that look right and open nothing.
//
// No test runner here (see package.json) — plain assertions + a non-zero exit.
//   npm run check:deep-link

import { buildDeepLink, buildSiteHealthDeepLink, parseDeepLink } from "../../../shared/deep-link.mjs";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// ── What a valid link resolves to ────────────────────────────────────

{
  const asTest = (url: string) => {
    const t = parseDeepLink(url);
    return t?.kind === "test" ? t : null;
  };
  const test = asTest("goodlooks://test/t-checkout");
  assert(test?.testId === "t-checkout", "a test link resolves to its test");
  assert(test?.runId === null && test?.stepId === null, "…with no run or step");

  const run = asTest("goodlooks://test/t-checkout/run/r-42");
  assert(run?.runId === "r-42", "a run link resolves to its run");

  const step = asTest("goodlooks://test/t-checkout/run/r-42/step/s5");
  assert(step?.stepId === "s5", "a step link resolves to its step");

  // Both shapes a person can end up pasting. Handling only one makes half the
  // links silently do nothing, which reads as a broken feature.
  assert(
    asTest("goodlooks:test/t-checkout")?.testId === "t-checkout",
    "the host-less form parses too",
  );

  assert(
    asTest("goodlooks://test/a%20b")?.testId === "a b",
    "a percent-escaped id is decoded",
  );
}

// ── Nothing traverses ────────────────────────────────────────────────

{
  const hostile = [
    "goodlooks://test/..",
    "goodlooks://test/.",
    "goodlooks://test/%2e%2e",
    "goodlooks://test/%2E%2E",
    "goodlooks://test/..%2F..%2Fetc%2Fpasswd",
    "goodlooks://test/%2f%2fetc%2fpasswd",
    "goodlooks://test/a%2Fb",
    "goodlooks://test/a%5Cb",
    "goodlooks://test/t-ok/run/..",
    "goodlooks://test/t-ok/run/r1/step/%2e%2e",
    // A malformed escape: decoding throws, and using the raw form instead
    // would mean the validator and the consumer disagree about the id.
    "goodlooks://test/%zz",
    // NUL, which truncates a C string — anything after it is invisible to a
    // consumer that stops there.
    "goodlooks://test/a%00b",
  ];
  for (const url of hostile) {
    assert(parseDeepLink(url) === null, `refused: ${url}`);
  }
}

{
  // Bounded. An id becomes a lookup key and, downstream, part of a path.
  const long = `goodlooks://test/${"x".repeat(500)}`;
  assert(parseDeepLink(long) === null, "an unbounded id is refused");
}

// ── Nothing is guessed ───────────────────────────────────────────────

{
  const nonsense = [
    "",
    "not a url",
    // Another app's scheme. Answering this would mean navigating on someone
    // else's link.
    "https://evil.example.com/test/t-1",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "goodlooks://",
    "goodlooks://test",
    // A verb this app does not implement. Resolving it to the test anyway
    // would open a coarser view than the link asked for, silently.
    "goodlooks://test/t-1/delete",
    "goodlooks://test/t-1/run/r-1/step/s-1/extra",
    "goodlooks://settings",
    "goodlooks://test/t-1/run",
  ];
  for (const url of nonsense) {
    assert(parseDeepLink(url) === null, `no route guessed for: ${url || "(empty)"}`);
  }

  assert(parseDeepLink(undefined) === null, "undefined resolves to nothing");
  assert(parseDeepLink(null) === null, "null resolves to nothing");
}

// ── A Site Health link selects a domain's screen ─────────────────────
//
// The host goes through the same gate the fixture's readings do, so a link
// can only name a domain the app could have measured; the category through
// the shared vocabulary, because it becomes a route param. Anything else is
// refused, never guessed — a link to `/site-health/x/speed` opens nothing
// rather than the SEO tab.
{
  const board = parseDeepLink("goodlooks://site-health/shop.example.com");
  assert(board?.kind === "site-health" && board.host === "shop.example.com", "a host link resolves to its domain");
  assert(board?.kind === "site-health" && board.category === null, "…with no tab when none was named");
  const tab = parseDeepLink("goodlooks://site-health/WWW.Shop.Example.com/performance");
  assert(tab?.kind === "site-health" && tab.host === "shop.example.com", "the host folds case and www. like every other host in the app");
  assert(tab?.kind === "site-health" && tab.category === "performance", "…and carries the tab");
  for (const url of [
    "goodlooks://site-health",
    "goodlooks://site-health/not a host",
    "goodlooks://site-health/shop.example.com/speed",
    "goodlooks://site-health/shop.example.com/seo/extra",
    "goodlooks://site-health/../shop.example.com",
    "goodlooks://site-health/shop.example.com%2f..",
  ]) {
    assert(parseDeepLink(url) === null, `refused: ${url}`);
  }
  for (const target of [
    { host: "shop.example.com", category: null },
    { host: "shop.example.com", category: "seo" as const },
    { host: "[::1]", category: "performance" as const },
  ]) {
    const round = parseDeepLink(buildSiteHealthDeepLink(target));
    assert(
      round?.kind === "site-health" && round.host === target.host && round.category === target.category,
      `site-health round-trips: ${JSON.stringify(target)}`,
    );
  }
  assert(parseDeepLink("goodlooks://test/t-checkout")?.kind === "test", "a test link says it is one");
}

// ── Build and parse agree ────────────────────────────────────────────

{
  const cases = [
    { testId: "t-1", runId: null, stepId: null },
    { testId: "t-1", runId: "r-1", stepId: null },
    { testId: "t-1", runId: "r-1", stepId: "s-1" },
    // Ids with characters that need escaping on the way out and decoding back.
    { testId: "t 1", runId: "r/1".replace("/", "-"), stepId: "s#1" },
  ];
  for (const target of cases) {
    const round = parseDeepLink(buildDeepLink(target));
    assert(
      round?.kind === "test" &&
        round.testId === target.testId &&
        round.runId === target.runId &&
        round.stepId === target.stepId,
      `round-trips: ${JSON.stringify(target)}`,
    );
  }

  // A step without a run is not expressible, and the builder must not emit a
  // link its own parser rejects.
  const orphan = parseDeepLink(buildDeepLink({ testId: "t-1", stepId: "s-1" }));
  assert(orphan?.kind === "test" && orphan.stepId === null, "a step with no run is dropped rather than emitted");
}

if (failures > 0) {
  console.error(`\n${failures} deep-link check(s) failed.`);
  process.exit(1);
}
console.log("\nAll deep-link checks passed.");
