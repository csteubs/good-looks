// The AI-debug completion notifier's pure halves.
//
// Same reasoning as run-notifier: the posting site can't be driven without a
// notification centre, so the gate and the wording are pure functions and the
// tests pin them here. The failure mode is silent in both directions — a
// notification the user turned off firing anyway, or the "answer is ready"
// banner never arriving for a job they walked away from.

import { describe, it, expect } from "vitest";

import { buildAiDebugNotice, shouldNotifyAiDebug } from "./ai-debug-notifier";

describe("shouldNotifyAiDebug", () => {
  it("stays silent when the setting is off", () => {
    expect(shouldNotifyAiDebug({ enabled: false })).toBe(false);
  });

  it("notifies when the setting is on", () => {
    expect(shouldNotifyAiDebug({ enabled: true })).toBe(true);
  });
});

describe("buildAiDebugNotice", () => {
  it("reports success — a finished minimized job IS the message", () => {
    const built = buildAiDebugNotice({ testName: "Checkout", status: "done" });
    expect(built.title).toContain("finished");
    expect(built.title).toContain("Checkout");
    expect(built.body).toContain("ready");
  });

  it("reports a failure as a failure, naming the test", () => {
    const built = buildAiDebugNotice({ testName: "Checkout", status: "error" });
    expect(built.title).toContain("failed");
    expect(built.title).toContain("Checkout");
  });
});
