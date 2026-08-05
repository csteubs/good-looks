// Standalone regression check for cookie steps.
//
// A cookie step has to survive a full round trip — step → generated spec →
// parsed back to step — because editing a test's script resyncs its steps
// through the parser. If generation and parsing disagree, a user who edits the
// script loses their cookie steps (or gets silently different ones).
//
// The high-risk part is that Chromium and Playwright disagree on vocabulary:
//   • Chromium `expirationDate` (unix seconds) ≡ Playwright `expires`
//   • Chromium "no_restriction" / "lax" / "strict" ≡ Playwright "None" / "Lax" / "Strict"
// Getting sameSite wrong silently produces a cookie the site won't send on
// navigation, which surfaces as a mysterious auth failure rather than an error.
//
// No test runner exists in this project (see package.json) — plain assertions +
// a non-zero exit code on failure stand in for one. Run with:
//   npm run check:cookie-steps

import { randomUUID } from "crypto";

import { generateSpec, describeStep } from "../script-generator.js";
import { parseSpecDetailed } from "../spec-parser.js";
import {
  cookieScopeIsValid,
  fromPlaywrightSameSite,
  toPlaywrightSameSite,
  type CookieSpec,
  type Step,
} from "../../recorder/types.js";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function cookieStep(
  cookieAction: "set" | "delete" | "clearAll",
  cookie?: CookieSpec,
): Step {
  return {
    id: randomUUID(),
    type: "cookie",
    cookieAction,
    ...(cookie ? { cookie } : {}),
    timestamp: 1,
  };
}

const gotoStep: Step = {
  id: randomUUID(),
  type: "goto",
  url: "https://example.com/",
  timestamp: 1,
};

function specFor(steps: Step[]): string {
  return generateSpec({ name: "Cookie test", url: "https://example.com/", steps });
}

/** Round trip: generate a spec from steps, parse it back, return the steps. */
function roundTrip(steps: Step[]): { steps: Step[]; skipped: number; spec: string } {
  const spec = specFor(steps);
  const parsed = parseSpecDetailed(spec);
  return { steps: parsed.steps, skipped: parsed.skipped, spec };
}

// ── sameSite mapping (both directions) ───────────────────────────────
assert(toPlaywrightSameSite("strict") === "Strict", "strict → Strict");
assert(toPlaywrightSameSite("lax") === "Lax", "lax → Lax");
assert(toPlaywrightSameSite("no_restriction") === "None", "no_restriction → None");
assert(toPlaywrightSameSite("unspecified") === null, "unspecified → omitted");
assert(toPlaywrightSameSite(undefined) === null, "undefined sameSite → omitted");
for (const v of ["strict", "lax", "no_restriction"] as const) {
  assert(
    fromPlaywrightSameSite(toPlaywrightSameSite(v)!) === v,
    `sameSite round-trips: ${v}`,
  );
}
assert(fromPlaywrightSameSite("nonsense") === undefined, "an unknown sameSite parses to undefined");

// ── Scope validation ─────────────────────────────────────────────────
assert(!cookieScopeIsValid(undefined), "no cookie → invalid scope");
assert(!cookieScopeIsValid({ name: "" }), "empty name → invalid scope");
assert(!cookieScopeIsValid({ name: "a" }), "name alone → invalid (Playwright would reject)");
assert(cookieScopeIsValid({ name: "a", url: "https://x.test/" }), "url alone → valid");
assert(cookieScopeIsValid({ name: "a", domain: "x.test", path: "/" }), "domain+path → valid");
assert(!cookieScopeIsValid({ name: "a", domain: "x.test" }), "domain without path → invalid");

// A scope-less set step must NOT emit a line: an addCookies call Playwright
// rejects fails the run during setup, which is far more confusing than the
// step simply not being emitted.
{
  const spec = specFor([gotoStep, cookieStep("set", { name: "a", value: "b" })]);
  assert(!spec.includes("addCookies"), "a scope-less cookie step emits no addCookies call");
}

// ── Generation ───────────────────────────────────────────────────────
{
  const spec = specFor([
    gotoStep,
    cookieStep("set", {
      name: "session",
      value: "abc123",
      domain: "example.com",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      expirationDate: 1893456000,
    }),
  ]);
  assert(spec.includes("page.context().addCookies(["), "emits addCookies on the page context");
  assert(spec.includes('name: "session"'), "emits the name");
  assert(spec.includes('value: "abc123"'), "emits the value");
  assert(spec.includes("expires: 1893456000"), "emits expirationDate as Playwright's `expires`");
  assert(!spec.includes("expirationDate"), "does NOT leak the Chromium field name into the spec");
  assert(spec.includes('sameSite: "Lax"'), "emits Playwright's sameSite spelling");
  assert(spec.includes("httpOnly: true") && spec.includes("secure: true"), "emits flags");
  // Playwright accepts url OR domain+path, never a mix.
  assert(!spec.includes("url:"), "omits url when domain+path are present");
}

{
  const spec = specFor([gotoStep, cookieStep("clearAll")]);
  assert(spec.includes("page.context().clearCookies();"), "clearAll emits an unfiltered clear");
}

{
  const spec = specFor([
    gotoStep,
    cookieStep("delete", { name: "session", domain: "example.com", path: "/" }),
  ]);
  assert(
    spec.includes('clearCookies({ name: "session", domain: "example.com", path: "/" })'),
    "delete emits a filtered clearCookies",
  );
}

// ── Round trip ───────────────────────────────────────────────────────
{
  const original = cookieStep("set", {
    name: "session",
    value: "abc123",
    domain: "example.com",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "no_restriction",
    expirationDate: 1893456000,
  });
  const { steps, skipped } = roundTrip([gotoStep, original]);
  const back = steps.find((s) => s.type === "cookie");
  assert(back !== undefined, "a set step survives the round trip");
  assert(skipped === 0, `round trip skips nothing (skipped=${skipped})`);
  assert(back?.cookieAction === "set", "action round-trips as set");
  assert(back?.cookie?.name === "session", "name round-trips");
  assert(back?.cookie?.value === "abc123", "value round-trips");
  assert(back?.cookie?.domain === "example.com", "domain round-trips");
  assert(back?.cookie?.path === "/", "path round-trips");
  assert(back?.cookie?.httpOnly === true, "httpOnly round-trips");
  assert(back?.cookie?.secure === true, "secure round-trips");
  assert(
    back?.cookie?.expirationDate === 1893456000,
    `expirationDate round-trips (got ${back?.cookie?.expirationDate})`,
  );
  assert(
    back?.cookie?.sameSite === "no_restriction",
    `sameSite round-trips through Playwright's spelling (got ${back?.cookie?.sameSite})`,
  );
}

{
  const { steps, skipped } = roundTrip([gotoStep, cookieStep("clearAll")]);
  const back = steps.find((s) => s.type === "cookie");
  assert(back?.cookieAction === "clearAll", "clearAll round-trips");
  assert(skipped === 0, "clearAll skips nothing");
}

{
  const { steps, skipped } = roundTrip([
    gotoStep,
    cookieStep("delete", { name: "session", domain: "example.com", path: "/" }),
  ]);
  const back = steps.find((s) => s.type === "cookie");
  assert(back?.cookieAction === "delete", "delete round-trips as delete, not clearAll");
  assert(back?.cookie?.name === "session", "delete keeps the cookie name");
  assert(skipped === 0, "delete skips nothing");
}

// A url-scoped cookie (no domain/path) round-trips through `url`.
{
  const { steps } = roundTrip([
    gotoStep,
    cookieStep("set", { name: "t", value: "1", url: "https://example.com/app" }),
  ]);
  const back = steps.find((s) => s.type === "cookie");
  assert(back?.cookie?.url === "https://example.com/app", "url-scoped cookies round-trip");
}

// Several cookies in one addCookies call become several steps.
{
  const src = `import { test, expect } from "@playwright/test";

test("multi", async ({ page }) => {
  await page.context().addCookies([{ name: "a", value: "1", domain: "x.test", path: "/" }, { name: "b", value: "2", domain: "x.test", path: "/" }]);
  await page.goto("https://x.test/");
});
`;
  const parsed = parseSpecDetailed(src);
  const cookies = parsed.steps.filter((s) => s.type === "cookie");
  assert(cookies.length === 2, `an addCookies call with 2 entries yields 2 steps (got ${cookies.length})`);
  assert(
    cookies.map((c) => c.cookie?.name).join(",") === "a,b",
    "multiple cookies keep their order",
  );
}

// An addCookies call the narrow parser can't read is COUNTED, not dropped —
// that's what drives TestRecord.stepsDiverged instead of silently undercounting.
{
  const src = `import { test, expect } from "@playwright/test";

test("computed", async ({ page }) => {
  await page.context().addCookies(buildCookies());
  await page.goto("https://x.test/");
});
`;
  const parsed = parseSpecDetailed(src);
  assert(
    parsed.steps.filter((s) => s.type === "cookie").length === 0,
    "a computed addCookies argument yields no cookie step",
  );
  assert(parsed.skipped > 0, "an unreadable addCookies call is counted as skipped");
}

// A clear filtered by something other than name isn't a per-cookie delete.
{
  const src = `import { test, expect } from "@playwright/test";

test("domain clear", async ({ page }) => {
  await page.context().clearCookies({ domain: "x.test" });
  await page.goto("https://x.test/");
});
`;
  const parsed = parseSpecDetailed(src);
  assert(
    parsed.steps.filter((s) => s.type === "cookie").length === 0,
    "a domain-only clearCookies is not misread as a delete",
  );
  assert(parsed.skipped > 0, "it is counted as skipped instead");
}

// Values needing escaping must survive.
{
  const tricky = 'a"b\\c';
  const { steps } = roundTrip([
    gotoStep,
    cookieStep("set", { name: "q", value: tricky, domain: "x.test", path: "/" }),
  ]);
  const back = steps.find((s) => s.type === "cookie");
  assert(back?.cookie?.value === tricky, `a quote/backslash value round-trips (got ${back?.cookie?.value})`);
}

// ── describeStep ─────────────────────────────────────────────────────
assert(
  describeStep(cookieStep("set", { name: "session", value: "abc", domain: "example.com" })) ===
    "set cookie session=abc on example.com",
  "describes a set step",
);
assert(describeStep(cookieStep("clearAll")) === "clear all cookies", "describes clearAll");
assert(
  describeStep(cookieStep("delete", { name: "session" })) === "delete cookie session",
  "describes a delete step",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll cookie-steps checks passed");
