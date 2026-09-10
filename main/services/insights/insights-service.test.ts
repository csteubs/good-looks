// The scheduler's firing decisions, driven with no clock, no LLM, no disk.
//
// Every scenario here is a silent misbehavior if wrong: a tick that fires
// while disabled sends data nobody consented to; a backoff that isn't stamped
// hammers a dead provider every minute; one stamped at attempt START survives
// a quit and delays the relaunch retry for an hour; a busy-deferral that
// stamps pushes a due report away because the user asked the AI something
// else; and a toggle-off that doesn't discard delivers a report the user just
// said they didn't want.

import { describe, expect, it, vi } from "vitest";

import type { InsightReport, InsightsState } from "../../recorder/types.js";
import { LlmCompletionError, type LlmCompletion } from "../llm-service.js";
import type { InsightFacts } from "./facts-builder.js";
import { createInsightsService, type InsightsDeps } from "./insights-service.js";
import { RETRY_BACKOFF_MS } from "./insight-schedule.js";
import { buildInsightsNotice } from "./insights-notifier.js";

const NOON_TUESDAY = new Date(2026, 7, 18, 12, 0).getTime();

function factsFixture(): InsightFacts {
  return {
    cadence: "weekly",
    periodLabel: "week",
    window: { since: NOON_TUESDAY - 7 * 86_400_000, until: NOON_TUESDAY },
    digest: { runs: 3, failed: 1, previousRuns: 0, offenders: [], flaky: 0, lines: ["3 runs."] },
    clusters: null,
    visualChangedSteps: null,
    heals: { healedSteps: 0, healFailures: 0, topTests: [] },
    a11y: { newViolationSteps: 0 },
    siteHealth: null,
    library: { totalTests: 1, testsCreated: 0, unreviewedScriptChanges: 0, pendingHeals: 0 },
    routines: [],
    shopify: [],
    app: { version: "1.0.0", previousVersion: null, releaseNotes: [] },
    tests: [{ id: "t1", name: "Login" }],
  };
}

const GOOD_ANSWER = JSON.stringify({
  headline: "One failure worth a look.",
  sections: [{ title: "Overview", body: "3 runs, 1 failed." }],
  actions: [{ kind: "debug-test", testId: "t1", label: "Login failed." }],
});

function completion(text: string): LlmCompletion {
  return {
    text,
    provider: "ollama",
    model: "test-model",
    promptChars: 100,
    answerChars: text.length,
    firstTokenMs: 12,
    durationMs: 340,
  };
}

interface Harness {
  deps: InsightsDeps;
  state: InsightsState;
  saved: InsightReport[];
  notices: { cadence: string; headline: string }[];
  noticeEnabled: boolean[];
  slacked: InsightReport[];
  completeCalls: number;
  advance(ms: number): void;
  set enabled(v: boolean);
}

function makeHarness(overrides: Partial<InsightsDeps> = {}) {
  const state: InsightsState = {
    lastGeneratedAt: null,
    lastAttemptAt: null,
    lastError: null,
    lastSeenAppVersion: null,
  };
  const saved: InsightReport[] = [];
  const notices: { cadence: string; headline: string }[] = [];
  const noticeEnabled: boolean[] = [];
  const slacked: InsightReport[] = [];
  let now = NOON_TUESDAY;
  let enabled = true;
  const h = {
    state,
    saved,
    notices,
    noticeEnabled,
    slacked,
    completeCalls: 0,
    advance: (ms: number) => {
      now += ms;
    },
    set enabled(v: boolean) {
      enabled = v;
    },
  };
  const deps: InsightsDeps = {
    now: () => now,
    newId: () => `id-${saved.length + 1}`,
    settings: () => ({
      aiInsightsEnabled: enabled,
      aiInsightsCadence: "weekly",
      notifyOnInsightsReady: true,
    }),
    state: () => ({ ...state }),
    saveState: (patch) => Object.assign(state, patch),
    buildFacts: async () => ({
      facts: factsFixture(),
      stats: {
        runs: 3,
        failed: 1,
        previousRuns: 0,
        flakyRuns: 0,
        healedSteps: 0,
        healFailures: 0,
        visualChanges: null,
        newClusters: null,
        a11yNewSteps: 0,
        testsCreated: 0,
        unreviewedScriptChanges: 0,
        expiringSignatures: 0,
        siteHealthDomains: null,
      },
      testIndex: new Set(["t1"]),
    }),
    refreshRedaction: async () => {},
    redact: (t) => t,
    complete: async () => {
      h.completeCalls++;
      return completion(GOOD_ANSWER);
    },
    interactiveCount: () => 0,
    saveReport: (r) => {
      saved.push(r);
      return r;
    },
    push: () => {},
    notify: (n, on) => {
      notices.push(n);
      noticeEnabled.push(on);
    },
    slack: (report) => {
      slacked.push(report);
    },
    appVersion: () => "1.0.0",
    ...overrides,
  };
  return Object.assign(h, { deps }) as Harness & { deps: InsightsDeps };
}

describe("insightsService firing decisions", () => {
  it("does nothing while disabled", async () => {
    const h = makeHarness();
    h.enabled = false;
    const svc = createInsightsService(h.deps);
    await svc.tick();
    expect(h.completeCalls).toBe(0);
    expect(h.state.lastAttemptAt).toBeNull();
  });

  it("never-generated + enabled fires on the first tick and stamps success", async () => {
    const h = makeHarness();
    const svc = createInsightsService(h.deps);
    await svc.tick();
    expect(h.completeCalls).toBe(1);
    expect(h.saved).toHaveLength(1);
    expect(h.state.lastGeneratedAt).toBe(NOON_TUESDAY);
    expect(h.state.lastError).toBeNull();
    expect(h.state.lastSeenAppVersion).toBe("1.0.0");
    expect(h.saved[0].headline).toBe("One failure worth a look.");
    expect(h.saved[0].actions).toHaveLength(1);
    expect(h.saved[0].read).toBe(false);
  });

  it("a satisfied period does not fire again", async () => {
    const h = makeHarness();
    const svc = createInsightsService(h.deps);
    await svc.tick();
    await svc.tick();
    expect(h.completeCalls).toBe(1);
  });

  it("notification carries the headline and the setting travels with it", async () => {
    const h = makeHarness();
    const svc = createInsightsService(h.deps);
    await svc.tick();
    expect(h.notices).toEqual([{ cadence: "weekly", headline: "One failure worth a look." }]);
    expect(h.noticeEnabled).toEqual([true]);
  });

  it("announces the SAVED report to Slack on success, and only then", async () => {
    const h = makeHarness();
    const svc = createInsightsService(h.deps);
    await svc.tick();
    // The saved report, not the raw parse — what the channel describes must be
    // what the app stored. The gate itself lives inside the announcer.
    expect(h.slacked).toHaveLength(1);
    expect(h.slacked[0]).toBe(h.saved[0]);
  });

  it("a failed generation announces nothing to Slack", async () => {
    const h = makeHarness({
      complete: async () => {
        throw new LlmCompletionError("down", "connection");
      },
    });
    const svc = createInsightsService(h.deps);
    await svc.tick();
    expect(h.slacked).toHaveLength(0);
  });

  it("a failure stamps the backoff at SETTLE and holds the next hour's ticks", async () => {
    const h = makeHarness({
      complete: async () => {
        throw new LlmCompletionError("Could not reach Ollama.", "connection");
      },
    });
    const svc = createInsightsService(h.deps);
    await svc.tick();
    expect(h.state.lastAttemptAt).toBe(NOON_TUESDAY);
    expect(h.state.lastError).toMatchObject({ kind: "connection" });
    expect(h.saved).toHaveLength(0);

    // Within the hour: held.
    h.advance(RETRY_BACKOFF_MS - 60_000);
    await svc.tick();
    expect(h.state.lastAttemptAt).toBe(NOON_TUESDAY);

    // Past it: retried.
    h.advance(120_000);
    await svc.tick();
    expect(h.state.lastAttemptAt).toBe(NOON_TUESDAY + RETRY_BACKOFF_MS + 60_000);
  });

  it("defers, UNSTAMPED, while an interactive request is in flight", async () => {
    let busy = 1;
    const h = makeHarness({ interactiveCount: () => busy });
    const svc = createInsightsService(h.deps);
    await svc.tick();
    expect(h.completeCalls).toBe(0);
    // Not an attempt: no backoff, so the next free tick fires immediately.
    expect(h.state.lastAttemptAt).toBeNull();
    busy = 0;
    await svc.tick();
    expect(h.completeCalls).toBe(1);
  });

  it("refuses to overlap: a second generation while one is in flight", async () => {
    let release!: (v: LlmCompletion) => void;
    const gate = new Promise<LlmCompletion>((r) => (release = r));
    const h = makeHarness({ complete: () => gate });
    const svc = createInsightsService(h.deps);
    const first = svc.generateNow();
    const second = await svc.generateNow();
    expect(second).toEqual({ started: false, reason: "alreadyRunning" });
    expect(svc.status().generating).toBe(true);
    release(completion(GOOD_ANSWER));
    await first;
    expect(svc.status().generating).toBe(false);
    expect(h.saved).toHaveLength(1);
  });

  it("generateNow skips the backoff — the user asked", async () => {
    const h = makeHarness();
    let fail = true;
    h.deps.complete = async () => {
      h.completeCalls++;
      if (fail) throw new LlmCompletionError("down", "connection");
      return completion(GOOD_ANSWER);
    };
    const svc = createInsightsService(h.deps);
    await svc.tick();
    expect(h.state.lastAttemptAt).not.toBeNull();
    fail = false;
    // A tick is held by the backoff; the button is not.
    await svc.tick();
    expect(h.completeCalls).toBe(1);
    const result = await svc.generateNow();
    expect(result).toEqual({ started: true });
    expect(h.saved).toHaveLength(1);
  });

  it("generateNow while disabled refuses rather than generating", async () => {
    const h = makeHarness();
    h.enabled = false;
    const svc = createInsightsService(h.deps);
    expect(await svc.generateNow()).toEqual({ started: false, reason: "disabled" });
    expect(h.completeCalls).toBe(0);
  });

  it("toggling off mid-generation discards the result and stamps nothing", async () => {
    let release!: (v: LlmCompletion) => void;
    const gate = new Promise<LlmCompletion>((r) => (release = r));
    const h = makeHarness({ complete: () => gate });
    const svc = createInsightsService(h.deps);
    const pending = svc.generateNow();
    h.enabled = false;
    release(completion(GOOD_ANSWER));
    await pending;
    expect(h.saved).toHaveLength(0);
    expect(h.state.lastGeneratedAt).toBeNull();
    expect(h.notices).toHaveLength(0);
  });

  it("a prose answer becomes a degraded report rather than a failure", async () => {
    const h = makeHarness({
      complete: async () => completion("Everything looks fine this week. Keep at it."),
    });
    const svc = createInsightsService(h.deps);
    await svc.tick();
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].degraded).toBe(true);
    expect(h.saved[0].actions).toEqual([]);
    expect(h.state.lastGeneratedAt).not.toBeNull();
  });

  it("the prompt content goes through the injected redactor", async () => {
    const redact = vi.fn((t: string) => t.split("hunter2").join("[redacted]"));
    let sent: string[] = [];
    const h = makeHarness({
      redact,
      buildFacts: async () => {
        const facts = factsFixture();
        facts.tests = [{ id: "t1", name: "Login with hunter2" }];
        return {
          facts,
          stats: {
            runs: 0,
            failed: 0,
            previousRuns: 0,
            flakyRuns: 0,
            healedSteps: 0,
            healFailures: 0,
            visualChanges: null,
            newClusters: null,
            a11yNewSteps: 0,
            testsCreated: 0,
            unreviewedScriptChanges: 0,
            expiringSignatures: 0,
            siteHealthDomains: null,
          },
          testIndex: new Set(["t1"]),
        };
      },
      complete: async (params) => {
        sent = params.messages.map((m) => m.content);
        return completion(GOOD_ANSWER);
      },
    });
    const svc = createInsightsService(h.deps);
    await svc.tick();
    expect(redact).toHaveBeenCalled();
    expect(sent.join("\n")).not.toContain("hunter2");
    expect(sent.join("\n")).toContain("[redacted]");
  });
});

describe("buildInsightsNotice", () => {
  it("titles by cadence, body is the report's own headline", () => {
    expect(buildInsightsNotice({ cadence: "weekly", headline: "H." })).toEqual({
      title: "Weekly insights ready",
      body: "H.",
    });
    expect(buildInsightsNotice({ cadence: "daily", headline: "H." }).title).toBe(
      "Daily insights ready",
    );
    expect(buildInsightsNotice({ cadence: "monthly", headline: "H." }).title).toBe(
      "Monthly insights ready",
    );
  });
});
