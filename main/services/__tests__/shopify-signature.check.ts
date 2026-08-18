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
//      its request forever.
//
//   4. A SIGNING-ONLY RUN WRITES NOTHING. Source-level again. Settling shipped
//      this bug once: a redirect reason that produces no artifact still pruned
//      the artifact history and created an empty run dir.
//
// Run with: npm run check:shopify-signature

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { generateSpec } from "../script-generator.js";
import { HEADER_NEVER_RECORD, LOG_CAPTURE_HELPERS, ELIDED } from "../log-capture-source.js";
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

  // The handler body, from its registration to the end of that statement. The
  // callback must be reachable on the throwing path too: Electron holds the
  // request until it is called, so a missed call hangs it forever and presents
  // as a page that never finishes loading, with a clean log.
  const at = src.indexOf("onBeforeSendHeaders(");
  const body = src.slice(at, src.indexOf("\n      }\n\n      logger.info", at));
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
