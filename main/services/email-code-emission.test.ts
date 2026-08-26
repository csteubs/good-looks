// The `emailCode` step from ingest to emitted line: the page boundary that
// refuses it, the fields the generator re-checks anyway, and the runtime the
// spec ends up importing. The rules the step DEPENDS on (the watermark, the
// code scan) are pinned in email-code.test.ts; what is pinned here is that the
// spec carries them.

import { describe, expect, it } from "vitest";

import { generateSpec, describeStep } from "./script-generator.js";
import { glazeRuntimeSource } from "../../shared/glaze-runtime-source.mjs";
import { codeFromMessage, codeWatermark } from "../../shared/email-code.mjs";
import { IPC_ONLY_STEP_TYPES, normalizeRawStep, normalizeStep } from "../recorder/types.js";
import type { Step } from "../recorder/types.js";

function gen(steps: Step[]): string {
  return generateSpec({ name: "t", url: "https://shop.test", steps } as Parameters<
    typeof generateSpec
  >[0]);
}

const STEP: Step = {
  id: "s1",
  timestamp: 0,
  type: "emailCode",
  mailboxAddress: "shopper@mail.example.com",
  captureVar: "loginCode",
};

describe("the page boundary", () => {
  it("refuses an emailCode step arriving from the page", () => {
    // A catch-all mailbox holds every test account's mail. A page that could
    // author this step could name another account's address, and the next
    // step would type that account's sign-in code into a field of the page's
    // choosing.
    expect(normalizeRawStep({ type: "emailCode", mailboxAddress: "a@b.com" })).toBeNull();
    expect(IPC_ONLY_STEP_TYPES).toContain("emailCode");
  });

  it("accepts it over IPC, which is where the trainer inserts it", () => {
    const step = normalizeStep(STEP);
    expect(step?.type).toBe("emailCode");
    expect(step?.mailboxAddress).toBe("shopper@mail.example.com");
  });

  it("rebuilds rather than spreads — an unknown field never rides along", () => {
    const step = normalizeStep({ ...STEP, evil: "payload" }) as unknown as Record<string, unknown>;
    expect(step).not.toHaveProperty("evil");
  });

  it("keeps a ${ref} address but refuses a malformed literal one", () => {
    // The reference is checked here; the address it resolves to is checked
    // again by the runtime helper, because only the run knows what it became.
    expect(normalizeStep({ ...STEP, mailboxAddress: "${shopperEmail}" })?.mailboxAddress).toBe(
      "${shopperEmail}",
    );
    expect(normalizeStep({ ...STEP, mailboxAddress: "not-an-address" })?.mailboxAddress).toBeUndefined();
    expect(
      normalizeStep({ ...STEP, mailboxAddress: "a@b.com\r\nX: 1" })?.mailboxAddress,
    ).toBeUndefined();
  });

  it("bounds the digit count and strips CR/LF from the label", () => {
    expect(normalizeStep({ ...STEP, codeDigits: 0 })?.codeDigits).toBeUndefined();
    expect(normalizeStep({ ...STEP, codeDigits: 99 })?.codeDigits).toBeUndefined();
    expect(normalizeStep({ ...STEP, codeDigits: 8 })?.codeDigits).toBe(8);
    // A forged numeric arriving as a STRING is the bug this whole boundary
    // exists for — it used to reach generated source verbatim.
    expect(normalizeStep({ ...STEP, codeDigits: '6); process.exit(1); (' })?.codeDigits).toBeUndefined();
    expect(normalizeStep({ ...STEP, codeLabel: "code is\r\nX" })?.codeLabel).toBeUndefined();
  });
});

describe("emission", () => {
  it("emits one awaited glazeEmailCode line and imports the helper", () => {
    const src = gen([STEP]);
    expect(src).toContain(
      'await glazeEmailCode(page, V, { address: "shopper@mail.example.com", captureVar: "loginCode" });',
    );
    expect(src).toContain('import { glazeEmailCode } from "./glaze-runtime.mjs";');
  });

  it("declares the V object the helper writes into", () => {
    // Without the header the helper writes into an object the spec never
    // built, and the fill that follows interpolates undefined.
    expect(gen([STEP])).toContain("const V");
  });

  it("interpolates a ${ref} address rather than quoting it literally", () => {
    const src = generateSpec({
      name: "t",
      url: "https://shop.test",
      steps: [{ ...STEP, mailboxAddress: "${shopperEmail}" }],
      variables: [{ name: "shopperEmail", kind: "plain", value: "a@b.com" }],
    } as Parameters<typeof generateSpec>[0]);
    // A whole-string reference emits as the bare variable, not a template —
    // which is what `valueExpr` does everywhere and is why the address is a
    // field rather than a hard-coded literal: one spelling of the customer's
    // email serves the login form and the mailbox poll.
    expect(src).toContain("address: V.shopperEmail");
    expect(src).not.toContain('address: "${shopperEmail}"');
  });

  it("emits digits and label only when they were set", () => {
    expect(gen([STEP])).not.toContain("digits:");
    expect(gen([STEP])).not.toContain("label:");
    const src = gen([{ ...STEP, codeDigits: 8, codeLabel: "login code is" }]);
    expect(src).toContain("digits: 8");
    expect(src).toContain('label: "login code is"');
  });

  it("re-checks the fields at EMISSION, not only at ingest", () => {
    // Tests recorded before a boundary fix are on disk and are regenerated
    // from their stored steps, so the generator needs its own guard
    // regardless (CLAUDE.md, the capture boundary).
    const forged = {
      ...STEP,
      codeDigits: '6); require("child_process").execSync("boom"); (' as unknown as number,
    } as Step;
    const src = gen([forged]);
    expect(src).not.toContain("child_process");
    expect(src).not.toContain("boom");
  });

  it("emits nothing for a step naming no destination variable", () => {
    // A code read into nowhere is not a step, and emitting a call with no
    // captureVar would have the helper write into `vars[undefined]`.
    const src = gen([{ ...STEP, captureVar: undefined }]);
    expect(src).not.toContain("glazeEmailCode");
  });

  it("does not import the helper for a spec with no such step", () => {
    const src = gen([{ id: "s", timestamp: 0, type: "reload" }]);
    expect(src).not.toContain("glazeEmailCode");
  });
});

describe("the runtime it lands in", () => {
  it("embeds the shared code scan and watermark verbatim", () => {
    // Two spellings of "which six digits did it mean" is how a step that
    // previews correctly in the trainer types the wrong number in the run.
    expect(glazeRuntimeSource).toContain(codeFromMessage.toString());
    expect(glazeRuntimeSource).toContain(codeWatermark.toString());
  });

  it("anchors the watermark at MODULE scope, not per call", () => {
    // Stamped when Playwright loads the runtime. Inside the helper it would
    // be "now", every message would beat it, and a code already sitting in
    // the mailbox would be typed — which is the failure the watermark is for.
    const at = glazeRuntimeSource.indexOf("const glazeRunStartedAt = Date.now();");
    expect(at).toBeGreaterThan(-1);
    expect(glazeRuntimeSource.indexOf("export async function glazeEmailCode")).toBeGreaterThan(at);
  });

  it("reads both halves of the watermark", () => {
    expect(glazeRuntimeSource).toContain(
      "glazeCodeWatermark(glazeRunStartedAt, glazeLastCode[address] || 0)",
    );
    expect(glazeRuntimeSource).toContain("glazeLastCode[address] = Number(message.receivedAt)");
  });

  it("goes through page.request.fetch, so the run's proxy applies", () => {
    // A bare fetch would bypass the proxy config; on a runner that only
    // egresses through one, that is the difference between a sign-in and a
    // timeout nobody can explain.
    expect(glazeRuntimeSource).toContain("page.request.fetch(url.toString()");
    expect(glazeRuntimeSource).not.toContain("await fetch(url");
  });

  it("stops on a rejected token instead of waiting out the budget", () => {
    expect(glazeRuntimeSource).toContain("rejected the token");
  });
});

describe("describeStep", () => {
  it("says what the user did, not which helper runs", () => {
    expect(describeStep(STEP)).toBe(
      'read the emailed sign-in code for "shopper@mail.example.com" into ${loginCode}',
    );
  });
});
