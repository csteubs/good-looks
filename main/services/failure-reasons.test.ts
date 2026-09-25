// The failure-reason vocabulary: resolution and the signal→reason mapping.
// The module under test is shared/failure-reasons.mjs — tested from here like
// the other shared engines (a11y-rollup, triage via check:triage), because the
// node test project owns main/**.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_FAILURE_REASONS,
  MAX_ACTIVE_CUSTOM_REASONS,
  MAX_REASON_DESCRIPTION,
  MAX_REASON_NAME,
  resolveFailureReason,
  suggestFailureReason,
} from "../../shared/failure-reasons.mjs";

function triageWith(...signals: string[]) {
  return {
    evidence: signals.map((signal) => ({ signal, direction: "site" as const, detail: "" })),
  };
}

describe("DEFAULT_FAILURE_REASONS", () => {
  it("has unique ids and a name and description for each", () => {
    const ids = DEFAULT_FAILURE_REASONS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of DEFAULT_FAILURE_REASONS) {
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
    }
  });

  it("keeps its names within the limits it imposes on custom reasons", () => {
    for (const r of DEFAULT_FAILURE_REASONS) {
      expect(r.name.length).toBeLessThanOrEqual(MAX_REASON_NAME);
      expect(r.description.length).toBeLessThanOrEqual(MAX_REASON_DESCRIPTION);
    }
    expect(MAX_ACTIVE_CUSTOM_REASONS).toBeGreaterThan(0);
  });

  it("deliberately has no accessibility reason — a11y findings never fail a run", () => {
    expect(DEFAULT_FAILURE_REASONS.some((r) => /accessib/i.test(r.name))).toBe(false);
  });
});

describe("resolveFailureReason", () => {
  it("resolves built-in ids", () => {
    expect(resolveFailureReason("regression")?.name).toBe("Site regression");
  });

  it("resolves custom ids, defaulting a missing description", () => {
    const custom = [{ id: "c1", name: "Vendor outage" }];
    expect(resolveFailureReason("c1", custom)).toEqual({
      id: "c1",
      name: "Vendor outage",
      description: "",
    });
  });

  it("still resolves a disabled custom reason's id — history keeps its name", () => {
    const custom = [{ id: "c1", name: "Vendor outage", description: "x", disabled: true }];
    expect(resolveFailureReason("c1", custom)?.name).toBe("Vendor outage");
  });

  it("answers null for unknown or empty ids", () => {
    expect(resolveFailureReason("nope")).toBeNull();
    expect(resolveFailureReason("")).toBeNull();
    expect(resolveFailureReason(null)).toBeNull();
  });
});

describe("suggestFailureReason", () => {
  it("maps site-ward signals to the regression reason", () => {
    for (const signal of ["server-error", "api-error", "page-error", "heal-exhausted"]) {
      expect(suggestFailureReason(triageWith(signal))).toEqual({
        reasonId: "regression",
        signal,
      });
    }
  });

  it("maps locator-shaped signals to the test-implementation reason", () => {
    for (const signal of ["heal-succeeded", "ambiguous-locator", "clean-wait"]) {
      expect(suggestFailureReason(triageWith(signal))?.reasonId).toBe("test-implementation");
    }
  });

  it("maps budget exhaustion to timing and engine-specific failures to environment", () => {
    expect(suggestFailureReason(triageWith("timeout-budget"))?.reasonId).toBe("timing");
    expect(suggestFailureReason(triageWith("single-engine"))?.reasonId).toBe("environment");
    expect(suggestFailureReason(triageWith("capture-only"))?.reasonId).toBe("environment");
  });

  it("reads only the STRONGEST signal — evidence arrives sorted", () => {
    expect(suggestFailureReason(triageWith("timeout-budget", "server-error"))?.reasonId).toBe(
      "timing",
    );
  });

  it("recognizes connect-level failures from the error line, ahead of any signal", () => {
    const lines = [
      "Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:9/",
      "Error: getaddrinfo ENOTFOUND myapp.example",
      "Error: page.goto: net::ERR_NAME_NOT_RESOLVED at https://gone.example/",
      "Error: connect ECONNREFUSED 127.0.0.1:9",
    ];
    for (const line of lines) {
      expect(suggestFailureReason(triageWith("server-error"), line)).toEqual({
        reasonId: "network",
        signal: "network-error",
      });
    }
  });

  it("survives signature normalization — digits and paths are already gone", () => {
    // errorSignature() rewrites numbers and paths but not words, so the stored
    // signature still carries the pattern the rule matches on.
    expect(
      suggestFailureReason(null, "Error: page.goto: net::ERR_CONNECTION_REFUSED at <path>"),
    ).toEqual({ reasonId: "network", signal: "network-error" });
  });

  it("does not read an ordinary HTTP failure as a network problem", () => {
    expect(suggestFailureReason(null, "Error: expect(received).toBe(expected)")).toBeNull();
    expect(suggestFailureReason(triageWith("server-error"), "Error: 503 from /api")).toEqual({
      reasonId: "regression",
      signal: "server-error",
    });
  });

  it("suggests nothing without evidence — uncategorized beats guessed", () => {
    expect(suggestFailureReason(null)).toBeNull();
    expect(suggestFailureReason({ evidence: [] })).toBeNull();
    expect(suggestFailureReason(triageWith("some-future-signal"))).toBeNull();
  });
});

describe("the not-actionable reason", () => {
  it("maps Playwright's actionability wording onto it", () => {
    for (const line of [
      'locator.click: Timeout 5000ms exceeded … <div class="cookie-bar"> intercepts pointer events',
      "element is outside of the viewport",
      "waiting for element to be visible, enabled and stable",
    ]) {
      expect(suggestFailureReason(null, line)).toEqual({
        reasonId: "not-actionable",
        signal: "actionability-error",
      });
    }
  });

  it("does NOT claim a plain resolve failure — a vanished element is not an overlay problem", () => {
    const res = suggestFailureReason(null, "Timeout 5000ms exceeded waiting for locator to be visible");
    expect(res?.reasonId).not.toBe("not-actionable");
  });

  it("resolves the new id like any built-in", () => {
    expect(resolveFailureReason("not-actionable")?.name).toBe("Target not actionable");
  });
});

describe("the credentials reason", () => {
  it("files a run that went out unsigned for an expired or unreadable signature", () => {
    expect(suggestFailureReason(null, "", { signature: "expired" })).toEqual({
      reasonId: "credentials",
      signal: "signature-expired",
    });
    expect(suggestFailureReason(null, "", { signature: "unreadable" })).toEqual({
      reasonId: "credentials",
      signal: "signature-unreadable",
    });
  });

  it("outranks the symptom triage and the error line would have named", () => {
    // What an unsigned run turned away by the store looks like: a timeout, or a
    // challenge page covering the target.
    expect(
      suggestFailureReason(triageWith("timeout-budget"), "Timeout 30000ms exceeded", {
        signature: "expired",
      })?.reasonId,
    ).toBe("credentials");
    expect(
      suggestFailureReason(null, "<div id=challenge> intercepts pointer events", {
        signature: "expired",
      })?.reasonId,
    ).toBe("credentials");
  });

  it("does not outrank a run that never reached the site", () => {
    expect(
      suggestFailureReason(null, "Error: page.goto: net::ERR_NAME_NOT_RESOLVED at https://x/", {
        signature: "expired",
      })?.reasonId,
    ).toBe("network");
  });

  it("changes nothing without a signature problem — the old mapping stands", () => {
    expect(suggestFailureReason(triageWith("server-error"), "", {})?.reasonId).toBe("regression");
    expect(suggestFailureReason(triageWith("server-error"), "", { signature: null })?.reasonId).toBe(
      "regression",
    );
    expect(suggestFailureReason(null, "", { signature: "valid" as never })).toBeNull();
  });

  it("resolves by the name it was asked for", () => {
    expect(resolveFailureReason("credentials")?.name).toBe("Credentials Expired/Invalid");
  });
});
