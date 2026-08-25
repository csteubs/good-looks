// Standalone regression check for the Shopify crawler signature.
//
// Everything here is a property no unit test reaches, and every one of them is
// silent when it breaks.
//
//   1. THE VALUE NEVER REACHES A GENERATED SPEC. That is the security boundary
//      CLAUDE.md states — page input → generated code → executed in Node — and
//      right now it holds only because nobody wired it. `check:step-ingest`
//      exists for exactly this shape of "true today, unenforced".
//
//   2. THE VALUE NEVER REACHES A RECORDED ARTIFACT. Driven through the REAL
//      `glazeFilterHeaders` string, evaluated the way the run evaluates it, so
//      what is verified is what ships.
//
//   3. THE TRAINER HOOK IS SHAPED THE WAY ELECTRON REQUIRES. Source-level,
//      because nothing else can reach it: Electron keeps ONE
//      `onBeforeSendHeaders` slot per session and a second registration
//      silently replaces the first, and a callback that is not invoked hangs
//      its request forever. Plus the two halves of "can anyone TELL?" — the
//      per-host tally of what was actually signed, and the announcement when a
//      signature is registered for a different host than the one being trained
//      against. `e2e/shopify-signature.spec.ts` is the other half of this
//      section: it asks a real server whether the header arrived, which is the
//      one question source-level assertions cannot answer.
//
//   3b. THE LIVE PAGE PRESENTS IT TOO. The app's third surface that loads a
//      customer's site, and the one that had neither credential.
//
//   4. A SIGNING-ONLY RUN WRITES NOTHING. Source-level again. Settling shipped
//      this bug once: a redirect reason that produces no artifact still pruned
//      the artifact history and created an empty run dir.
//
// Run with: npm run check:shopify-signature

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { generateSpec } from "../script-generator.js";
import { HEADER_NEVER_RECORD, LOG_CAPTURE_HELPERS, ELIDED } from "../../../shared/log-capture-source.mjs";
import { SIGNATURE_HEADER_NAMES } from "../../../shared/shopify-signature.mjs";
import type { TestRecord } from "../../recorder/types.js";

const root = process.cwd();

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const SIGNATURE = "sig1=:dGhpcy1pcy10aGUtc2lnbmF0dXJl:";
const SIGNATURE_INPUT =
  'sig1=("@authority");created=1735689600;expires=4102444799;keyid="kkk";alg="ed25519"';

// ── 1. The value never reaches a generated spec ──────────────────────
{
  // A test whose every free-text field carries the signature. If ANY of them is
  // interpolated into the spec, the credential ends up in a file on disk that
  // the app also shows in the script view and hands to Debug with AI.
  const record: TestRecord = {
    id: "t-sig",
    name: `Shop ${SIGNATURE}`,
    url: "https://shop.example.com/",
    createdAt: 0,
    updatedAt: 0,
    steps: [
      { id: "s1", kind: "goto", url: "https://shop.example.com/", at: 0 },
      {
        id: "s2",
        kind: "fill",
        value: SIGNATURE,
        locator: { k: "testid", v: "q" },
        at: 0,
      },
    ],
  } as unknown as TestRecord;

  const spec = generateSpec(record);
  // The signature CAN legitimately appear when the user types it as a step
  // value — that is their own recorded input, not something this feature put
  // there. What must never appear is a header name paired with a value the
  // signature store holds, i.e. any sign that the generator learned about
  // signatures at all.
  for (const name of SIGNATURE_HEADER_NAMES) {
    assert(
      !spec.toLowerCase().includes(name),
      `a generated spec names no ${name} header (the generator knows nothing about signatures)`,
    );
  }
  assert(
    !spec.includes("GLAZE_SIG_"),
    "a generated spec references no GLAZE_SIG_* variable — the headers are attached by the fixture",
  );
  assert(
    !spec.includes("extraHTTPHeaders") && !spec.includes("setExtraHTTPHeaders"),
    "a generated spec sets no context-wide headers",
  );
}

// ── 2. The value never reaches a recorded artifact ───────────────────
{
  const helpers = new Function(
    `${LOG_CAPTURE_HELPERS}\nreturn { glazeFilterHeaders };`,
  )() as {
    glazeFilterHeaders: (h: Record<string, string>, allowAll: boolean) => Record<string, string>;
  };

  // Both ways, because `recordAllHeaders` is the user's opt-out for headers the
  // PAGE sends and must not reach a header this app injected.
  for (const allowAll of [true, false]) {
    const filtered = helpers.glazeFilterHeaders(
      {
        "Signature-Input": SIGNATURE_INPUT,
        Signature: SIGNATURE,
        "Signature-Agent": '"https://shopify.com"',
        "content-type": "text/html",
      },
      allowAll,
    );
    const serialized = JSON.stringify(filtered);
    assert(
      !serialized.includes("dGhpcy1pcy10aGUtc2lnbmF0dXJl"),
      `no signature value survives glazeFilterHeaders (allowAll=${allowAll})`,
    );
    assert(!serialized.includes("keyid"), `…nor the Signature-Input (allowAll=${allowAll})`);
    for (const name of SIGNATURE_HEADER_NAMES) {
      assert(filtered[name] === ELIDED, `${name} is elided (allowAll=${allowAll})`);
    }
    assert(
      filtered["content-type"] === "text/html",
      `…while an ordinary header is untouched (allowAll=${allowAll})`,
    );
  }

  assert(
    HEADER_NEVER_RECORD.length === SIGNATURE_HEADER_NAMES.length,
    "the never-list is exactly the signature headers — the escape hatch still covers everything else",
  );
}

// ── 3. The trainer hook's shape ──────────────────────────────────────
{
  const src = readFileSync(join(root, "main/services/recorder-service.ts"), "utf-8");
  const registrations = src.split("onBeforeSendHeaders(").length - 1;
  assert(
    registrations === 1,
    `recorder-service.ts registers onBeforeSendHeaders exactly once (found ${registrations}) — ` +
      "Electron keeps one slot per session and a second registration silently replaces the first",
  );

  /**
   * The text between two markers — or "" when either is missing.
   *
   * FAILS CLOSED, and that is the whole reason it exists. Every slice here used
   * a bare `src.indexOf(end, at)` for its end marker, and `indexOf` answers -1
   * rather than throwing: `slice(at, -1)` is then "everything from here to the
   * last character of the file". So a marker broken by an innocent reindent did
   * not fail the check — it silently widened the window to the rest of the
   * module, and every assertion below went on passing against text that has
   * nothing to do with the code it names. An empty slice fails them all
   * instead, which is the direction a guard should break in.
   */
  const between = (start: string, end: string, from = 0): string => {
    const a = src.indexOf(start, from);
    if (a < 0) return "";
    const b = src.indexOf(end, a + start.length);
    return b < 0 ? "" : src.slice(a, b);
  };

  // The handler body, from its registration to the end of that statement. The
  // callback must be reachable on the throwing path too: Electron holds the
  // request until it is called, so a missed call hangs it forever and presents
  // as a page that never finishes loading, with a clean log.
  const body = between("onBeforeSendHeaders(", "\n      }\n\n      logger.info");
  assert(
    body !== "",
    "the header handler's end marker still resolves — a slice that fails open would make every " +
      "assertion below pass against the rest of the file",
  );
  assert(body.includes("try {"), "the header handler wraps its work in a try");
  const afterCatch = body.slice(body.indexOf("} catch"));
  assert(
    afterCatch.includes("callback("),
    "…and calls the callback from the catch, so a throw cannot hang the request",
  );
  assert(
    body.includes("signatureForUrl("),
    "…and re-checks the host itself rather than trusting the URL filter's glob semantics",
  );

  // WHAT IT SIGNED, not just what it was armed for. The run fixture counts this
  // because "armed and signed zero requests" is the feature's likeliest silent
  // failure; the trainer is the surface where a person is actually watching the
  // page, and it had no counterpart at all. A tally that is armed but never
  // incremented reads exactly like one that signed everything.
  assert(
    body.includes("signedRequests.set("),
    "the header handler counts what it signed — the run fixture's per-host tally, on the " +
      "trainer side, where the only other evidence is a page that quietly serves a password form",
  );
  // THE ARMING HALF, which nothing pinned until it was pointed out. The tally's
  // log line is gated on `signatureArmed.length > 0`, and `signatureArmed` has
  // exactly one writer: the line beside the listener registration. Delete that
  // one line — during any later tidy of the containment block, where it reads
  // as redundant with the `signedHosts` field already in the "armed" log — and
  // the value stays `[]` for every session, the end-of-session line never
  // prints, and the whole "armed but signed zero" report is dead. It still
  // compiles, lints, type-checks, and the e2e spec still passes because that
  // reads the wire rather than the log. Which is the same silent-failure shape
  // the tally was added to expose, one level up.
  const armBlock = between("if (signatureEntries.length > 0) {", "\n      }");
  assert(
    /signatureArmed = signatureEntries\.map\(/.test(armBlock),
    "the session records WHAT IT WAS ARMED FOR beside the listener registration — the tally's " +
      "log is gated on it, so without this writer the whole diagnostic is silently dead",
  );

  // Bounded to the function, not "from here to the end of the file". The first
  // version of this sliced from `indexOf` to EOF, which is most of the module —
  // so it asserted only that those strings exist SOMEWHERE below, and would
  // have stayed green with the resets moved anywhere at all. Which is exactly
  // what happened next: they belonged in `destroyViews`, not here.
  const fnBody = (name: string): string => {
    const a = src.indexOf(`function ${name}(`);
    if (a < 0) return "";
    const end = src.indexOf("\n}", a);
    return end < 0 ? "" : src.slice(a, end);
  };
  const report = fnBody("reportSignatures");
  assert(
    /signatureArmed = \[\];/.test(report) && /signedRequests = new Map\(\);/.test(report),
    "reportSignatures resets BOTH halves — a tally carried into the next session reports the " +
      "previous one's requests against the new one's hosts",
  );
  assert(
    /signed: Object\.fromEntries\(signedRequests\)/.test(report) &&
      /armed: signatureArmed/.test(report),
    "…and logs the PAIR, since armed-with-nothing-signed is the case worth seeing",
  );
  // WHERE it is called from is the load-bearing part. Every teardown path runs
  // `stopPolling` BEFORE the page is gone, so reporting there logs and resets
  // while the listener is still installed — a request landing in that window is
  // counted into the next session and reported against the next session's
  // hosts. `destroyViews` is where the page actually goes away.
  assert(
    fnBody("destroyViews").includes("reportSignatures()"),
    "…and is called from destroyViews, not stopPolling — the page (and the listener) is still " +
      "alive when stopPolling runs",
  );

  // The trainer's start-of-session announcement. The run has named the
  // wrong-domain case since the feature landed (`announceSignatureState`); the
  // trainer named only expired and unreadable, so "I registered one and the
  // trainer still shows the password page" had no answer in the app at all.
  assert(
    src.includes('reason: "other-host"'),
    "the trainer announces a signature registered for a DIFFERENT host — a signature is bound " +
      "to one authority, and that is the commonest reason a trainer sits on the bot wall",
  );
  // STRUCTURAL, not ordering. The first version compared two `indexOf` results
  // and claimed that proved the guard enclosed the announcement; it proved only
  // that the two strings appear in that order somewhere in a four-thousand-line
  // file. The refactor that defeats it is an ordinary readability edit — hoist
  // the predicate into a `const` above the branch — after which the
  // announcement is unconditional and every user who has ever registered a
  // signature gets a toast on every recording of every unrelated host, with the
  // check still green.
  //
  // So: find the announcement, walk BACK to the branch that opens it, and read
  // that branch's own condition. Now the assertion is about the code that
  // actually guards the call.
  const announceAt = src.indexOf('reason: "other-host"');
  const branchAt = src.lastIndexOf("} else if (", announceAt);
  const condition = between("} else if (", ") {", branchAt > 0 ? branchAt : 0);
  assert(
    announceAt > 0 && branchAt > 0 && condition.includes("signatureEntries.length > 0"),
    "the other-host announcement sits INSIDE a branch guarded on USABLE entries, as " +
      "announceSignatureState is — not on the register, which carries expired and unreadable rows",
  );
  assert(
    condition.includes("!status") && condition.includes("startHost"),
    "…and that same branch requires no entry for this host and a host it could parse — a machine " +
      "with no signatures must not be told about a feature it is not using, on every recording",
  );
  assert(
    !/registered\.map\(\(entry\) => entry\.host\)/.test(src),
    "…and names usable hosts, never the register's — 'one is registered for X' is only " +
      "actionable if X could actually be presented",
  );
}

/**
 * Source with its COMMENTS removed.
 *
 * Written the first time an assertion below went red against the very comment
 * explaining why the thing it forbids is forbidden — `extraHTTPHeaders`
 * appears in `live-page-service.ts` only inside "never
 * `newContext({ extraHTTPHeaders })`". A source-level check that cannot tell
 * code from prose fails on the correct fix and passes on a comment, which is
 * both directions of wrong.
 *
 * Block comments, and line comments only where the line is nothing else —
 * which is this repo's style, and which leaves a `"https://…"` inside real
 * code alone. A trailing `//` after code would survive; nothing here needs it
 * to be stripped, and a regex that tried would eat those URLs.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

// ── 3b. The live page presents it too ────────────────────────────────
{
  // The THIRD surface that loads a customer's site. It arrived after this
  // feature and presented neither credential, so a protected storefront served
  // the Script IDE's live page the password page while the same test's runs
  // sailed through. Source-level here for the two properties that are silent
  // when they break; `check:live-page` proves the header actually arrives, and
  // `live-page-service.test.ts` proves the arm rule.
  const src = codeOnly(readFileSync(join(root, "main/services/live-page-service.ts"), "utf-8"));

  assert(
    !src.includes("extraHTTPHeaders"),
    "the live page never sets context-wide headers — that would hand the credential to the " +
      "storefront's CDN, its analytics and every app the merchant installed",
  );
  assert(
    src.includes("signatureForUrl("),
    "…it decides per request through the shared signatureForUrl, not a host rule of its own",
  );
  // Every path out of the route handler must continue the request. An
  // un-continued route hangs it until the page's own timeout, which presents as
  // a live page that never finishes loading — the same property the trainer's
  // callback has, and just as invisible.
  const at = src.indexOf("async function installSignatureRoute(");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert(at > 0 && /catch[\s\S]*route\.continue\(/.test(body),
    "…and its route handler continues the request from the catch, so a throw cannot hang it",
  );
  assert(
    src.includes("credentialOrigin("),
    "the live page scopes basic auth through the SHARED credentialOrigin — an unscoped " +
      "httpCredentials answers any server's 401, so a third-party subresource gets the password",
  );
}

// ── 4. A signing-only run writes nothing ─────────────────────────────
{
  const src = readFileSync(join(root, "main/services/playwright-runner.ts"), "utf-8");
  const at = src.indexOf("const artifactRun =");
  assert(at > 0, "playwright-runner.ts still computes artifactRun");
  const line = src.slice(at, src.indexOf(";", at));
  assert(
    !line.includes("signing"),
    "signing is NOT part of artifactRun — a run that only attaches a header must not prune " +
      "the artifact history to create an empty run dir",
  );
  // …while it IS part of the redirect gate, or the fixture never loads and the
  // header is never attached at all.
  assert(
    /captureArtifacts \|\| healing \|\| a11y \|\| recordLogs \|\| settling \|\| signing/.test(src),
    "…but signing IS part of the gate that redirects the spec at the capture fixture",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Shopify signature checks passed");
