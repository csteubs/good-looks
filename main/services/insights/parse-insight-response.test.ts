// The response parser, and the property that keeps the prompt honest.
//
// The load-bearing test is the knowledge property at the bottom — the same
// property `renderer/lib/llm-knowledge.test.ts` pins for AI steps: every
// action kind the prompt OFFERS survives the parser. The drift it prevents is
// silent in the worst way: a kind added to the prompt but not the validator
// means the model's recommendation is deleted with no error, and the user
// simply gets a report with fewer buttons than the model produced.

import { describe, expect, it } from "vitest";

import { INSIGHT_ACTION_KINDS } from "../../recorder/types.js";
import type { InsightFacts } from "./facts-builder.js";
import {
  buildInsightMessages,
  describeInsightsSending,
  INSIGHTS_SYSTEM_PROMPT,
} from "./insight-prompts.js";
import { parseInsightResponse } from "./parse-insight-response.js";

const KNOWN = new Set(["t1", "t2"]);

const body = {
  headline: "A quiet week with one flaky login test.",
  sections: [{ title: "Overview", body: "12 runs, 2 failed." }],
  actions: [{ kind: "debug-test", testId: "t1", label: "Login failed 3 times in a row." }],
};

describe("parseInsightResponse", () => {
  it("parses the contract from a fenced json block", () => {
    const text = `Here is the report.\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\nDone.`;
    const out = parseInsightResponse(text, KNOWN);
    expect(out.degraded).toBe(false);
    expect(out.headline).toBe(body.headline);
    expect(out.sections).toHaveLength(1);
    expect(out.actions).toEqual([
      { kind: "debug-test", testId: "t1", label: "Login failed 3 times in a row." },
    ]);
  });

  it("falls back to the widest {...} span when the model skips the fence", () => {
    const text = `Sure! ${JSON.stringify(body)} — hope that helps.`;
    const out = parseInsightResponse(text, KNOWN);
    expect(out.degraded).toBe(false);
    expect(out.headline).toBe(body.headline);
  });

  it("tolerates an unclosed trailing fence — a model cut off mid-answer", () => {
    const text = "```json\n" + JSON.stringify(body);
    const out = parseInsightResponse(text, KNOWN);
    expect(out.degraded).toBe(false);
  });

  it("drops an action naming a test the model was never shown", () => {
    // The parse-time half of the double validation: an invented (or injected)
    // id must never be persisted, however plausible it looks.
    const text = JSON.stringify({
      ...body,
      actions: [
        { kind: "run-test", testId: "t-invented", label: "Run this." },
        { kind: "run-test", testId: "t2", label: "Run that." },
      ],
    });
    const out = parseInsightResponse(text, KNOWN);
    expect(out.actions).toEqual([{ kind: "run-test", testId: "t2", label: "Run that." }]);
  });

  it("drops an unknown action kind rather than guessing", () => {
    const text = JSON.stringify({
      ...body,
      actions: [{ kind: "delete-test", testId: "t1", label: "Nope." }],
    });
    expect(parseInsightResponse(text, KNOWN).actions).toEqual([]);
  });

  it("strips extra keys an action rode in on", () => {
    const text = JSON.stringify({
      ...body,
      actions: [
        { kind: "open-stats", label: "Look at stats.", url: "https://evil.example", exec: "rm" },
      ],
    });
    const [action] = parseInsightResponse(text, KNOWN).actions;
    expect(action).toEqual({ kind: "open-stats", label: "Look at stats." });
  });

  it("caps actions and sections", () => {
    const text = JSON.stringify({
      ...body,
      sections: Array.from({ length: 12 }, (_v, i) => ({ title: `S${i}`, body: "x" })),
      actions: Array.from({ length: 10 }, (_v, i) => ({
        kind: "open-stats",
        label: `Reason ${i}.`,
      })),
    });
    const out = parseInsightResponse(text, KNOWN);
    expect(out.sections.length).toBeLessThanOrEqual(8);
    expect(out.actions.length).toBeLessThanOrEqual(6);
  });

  it("keeps an unparseable answer as a degraded prose report with no actions", () => {
    const text = "## This week\nEverything was mostly fine.\nRun the login test again.";
    const out = parseInsightResponse(text, KNOWN);
    expect(out.degraded).toBe(true);
    expect(out.headline).toBe("This week");
    expect(out.sections[0]?.body).toContain("mostly fine");
    // A button parsed out of free text is a guess with side effects.
    expect(out.actions).toEqual([]);
  });

  it("requires a headline for a candidate to count as the contract", () => {
    const text = JSON.stringify({ sections: body.sections, actions: [] });
    expect(parseInsightResponse(text, KNOWN).degraded).toBe(true);
  });
});

// ── The knowledge property ─────────────────────────────────────────────────

function factsFixture(): InsightFacts {
  return {
    cadence: "weekly",
    periodLabel: "week",
    window: { since: 0, until: 1 },
    digest: { runs: 1, failed: 0, previousRuns: 0, offenders: [], flaky: 0, lines: ["1 run."] },
    clusters: null,
    visualChangedSteps: null,
    heals: { healedSteps: 0, healFailures: 0, topTests: [] },
    a11y: { newViolationSteps: 0 },
    library: { totalTests: 2, testsCreated: 0, unreviewedScriptChanges: 0, pendingHeals: 0 },
    routines: [],
    shopify: [],
    app: { version: "1.0.0", previousVersion: null, releaseNotes: [] },
    tests: [
      { id: "t1", name: "Login" },
      { id: "t2", name: "Checkout" },
    ],
  };
}

describe("the prompt and the parser agree", () => {
  it("every action kind the prompt offers survives the parser", () => {
    // One response per kind, not all kinds in one response — the action CAP is
    // a separate rule (there are more kinds than the per-report maximum), and
    // batching them here would let the cap mask a kind the validator dropped.
    for (const kind of INSIGHT_ACTION_KINDS) {
      const response = JSON.stringify({
        headline: "One kind.",
        sections: [{ title: "S", body: "b" }],
        actions: [{ kind, testId: "t1", label: `Use ${kind}.` }],
      });
      const out = parseInsightResponse(response, KNOWN);
      expect(out.actions.map((a) => a.kind)).toEqual([kind]);
    }
  });

  it("and the prompt names every kind, verbatim", () => {
    for (const kind of INSIGHT_ACTION_KINDS) {
      expect(INSIGHTS_SYSTEM_PROMPT).toContain(JSON.stringify(kind));
    }
  });
});

describe("the sending disclosure is derived, not maintained", () => {
  it("describes exactly the payload categories the prompt serializes", () => {
    const facts = factsFixture();
    const messages = buildInsightMessages(facts);
    expect(messages[0]?.role).toBe("system");
    const user = messages[1];
    expect(user?.role).toBe("user");
    const json = JSON.parse(String(user?.content).replace(/^Data \(JSON\):\n/, "")) as Record<
      string,
      unknown
    >;
    const sending = describeInsightsSending(facts);
    // Same count as the payload's top-level keys: a category added to the
    // payload cannot be silently missing from the disclosure.
    expect(sending).toHaveLength(Object.keys(json).length);
    for (const item of sending) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.chars).toBeGreaterThan(0);
    }
  });

  it("the payload carries no log, script or console text by shape", () => {
    // The structural half of the egress guarantee, from the type: InsightFacts
    // has no field that could hold a log. This pins the serialized payload's
    // key set so a new field is a conscious decision, not drift.
    const messages = buildInsightMessages(factsFixture());
    const json = JSON.parse(String(messages[1]?.content).replace(/^Data \(JSON\):\n/, ""));
    expect(Object.keys(json as Record<string, unknown>).sort()).toEqual(
      [
        "accessibility",
        "app",
        "crawlerSignatures",
        "digest",
        "failureClusters",
        "heals",
        "library",
        "period",
        "scheduledRoutines",
        "tests",
        "visualChangedSteps",
      ].sort(),
    );
  });
});
