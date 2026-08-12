// Detecting that the model asked for the run's console/network.
//
// The two failure directions are wildly asymmetric, and these tests are shaped
// around that. Missing a request is harmless — the user reads the reply and
// asks again. A FALSE POSITIVE arms a button that offers to send page-
// controlled text and request URLs to a model, possibly a hosted one, because
// the model wrote an ordinary English sentence about logs. So most of what is
// pinned here is what must NOT be treated as a request.

import { describe, it, expect } from "vitest";

import {
  ALL_NEEDS,
  describeNeed,
  logRequestProtocol,
  parseLogRequest,
  stripLogRequest,
} from "./ai-log-request";

const block = (json: string) => "Some diagnosis.\n\n```glaze-request\n" + json + "\n```";

describe("parseLogRequest", () => {
  it("reads a well-formed request", () => {
    expect(parseLogRequest(block('{"need":["console"],"why":"a JS error may explain it"}'))).toEqual({
      need: ["console"],
      why: "a JS error may explain it",
    });
  });

  it("reads both kinds at once", () => {
    expect(parseLogRequest(block('{"need":["network","console"]}'))?.need).toEqual([
      // Canonical order regardless of how the model listed them, so downstream
      // comparisons (already-fulfilled bookkeeping) are stable.
      "console",
      "network",
    ]);
  });

  it("de-duplicates repeated needs", () => {
    expect(parseLogRequest(block('{"need":["console","console"]}'))?.need).toEqual(["console"]);
  });

  it("tolerates case and surrounding whitespace", () => {
    expect(parseLogRequest(block('{"need":[" Console "]}'))?.need).toEqual(["console"]);
  });

  it("defaults a missing reason to empty rather than failing", () => {
    expect(parseLogRequest(block('{"need":["console"]}'))?.why).toBe("");
  });
});

describe("parseLogRequest does not fire on prose", () => {
  it("ignores the model merely talking about console logs", () => {
    // The sentence a debugging model writes constantly.
    const reply =
      "The click probably failed silently. You should check the console logs and the network " +
      "tab for a failed request, and see if anything was logged.";
    expect(parseLogRequest(reply)).toBeNull();
  });

  it("ignores a JSON object that isn't in a tagged fence", () => {
    expect(parseLogRequest('Try this: {"need":["console"]}')).toBeNull();
  });

  it("ignores an untagged code fence containing the same JSON", () => {
    expect(parseLogRequest('```\n{"need":["console"]}\n```')).toBeNull();
  });

  it("ignores a differently-tagged fence", () => {
    expect(parseLogRequest('```json\n{"need":["console"]}\n```')).toBeNull();
    expect(parseLogRequest('```ts\n{"need":["console"]}\n```')).toBeNull();
  });

  it("ignores a malformed block rather than guessing at intent", () => {
    expect(parseLogRequest(block("{need: console}"))).toBeNull();
    expect(parseLogRequest(block("not json at all"))).toBeNull();
    expect(parseLogRequest(block(""))).toBeNull();
  });

  it("ignores a well-formed block asking for something unknown", () => {
    // A model inventing "cookies" or "screenshots" must not resolve to some
    // nearest-neighbour guess about what to hand over.
    expect(parseLogRequest(block('{"need":["cookies"]}'))).toBeNull();
    expect(parseLogRequest(block('{"need":["everything"]}'))).toBeNull();
    expect(parseLogRequest(block('{"need":[]}'))).toBeNull();
    expect(parseLogRequest(block('{"why":"please"}'))).toBeNull();
  });

  it("ignores an array or a bare string as the payload", () => {
    expect(parseLogRequest(block('["console"]'))).toBeNull();
    expect(parseLogRequest(block('"console"'))).toBeNull();
  });

  it("is null for an empty or absent response", () => {
    expect(parseLogRequest("")).toBeNull();
    expect(parseLogRequest("Just a diagnosis with no request.")).toBeNull();
  });
});

describe("parseLogRequest with several blocks", () => {
  it("takes the model at its final word", () => {
    // A model that echoes the protocol's own example before writing its real
    // request would otherwise be read as asking for both.
    const reply = block('{"need":["console","network"],"why":"example"}') + "\n\nActually:\n\n" +
      "```glaze-request\n{\"need\":[\"network\"],\"why\":\"only the failed call matters\"}\n```";
    expect(parseLogRequest(reply)).toEqual({
      need: ["network"],
      why: "only the failed call matters",
    });
  });

  it("falls back to an earlier valid block when the last one is malformed", () => {
    const reply = block('{"need":["console"],"why":"real"}') + "\n\n```glaze-request\nbroken\n```";
    expect(parseLogRequest(reply)?.need).toEqual(["console"]);
  });
});

describe("stripLogRequest", () => {
  it("removes the machine-readable block from what the user reads", () => {
    const out = stripLogRequest(block('{"need":["console"]}'));
    expect(out).toBe("Some diagnosis.");
    expect(out).not.toContain("glaze-request");
  });

  it("leaves a response with no request untouched", () => {
    expect(stripLogRequest("Just prose.")).toBe("Just prose.");
  });

  it("leaves ordinary code blocks alone", () => {
    const reply = "Fix:\n\n```ts\nawait page.click('x');\n```";
    expect(stripLogRequest(reply)).toBe(reply);
  });
});

describe("the protocol text", () => {
  it("describes the exact format the parser accepts", () => {
    // Prompt and parser drifting apart would mean a model that follows
    // instructions perfectly and is never heard.
    const text = logRequestProtocol(ALL_NEEDS);
    const example = text.slice(text.indexOf("```glaze-request"));
    expect(parseLogRequest(example)).toEqual({
      need: ALL_NEEDS,
      why: "one short sentence",
    });
  });

  it("advertises only the needs this run can actually answer", () => {
    // Offering data that doesn't exist costs the user a round trip to find
    // out, and teaches the model to ask for things nobody can supply.
    const logsOnly = logRequestProtocol(["console", "network"]);
    expect(logsOnly).toContain('"console"');
    expect(logsOnly).not.toContain('"structure"');

    const structureOnly = logRequestProtocol(["structure"]);
    expect(structureOnly).toContain('"structure"');
    expect(structureOnly).not.toContain('"console"');
    // And its example must still parse — a subset that emits a block naming a
    // need the app cannot answer would be worse than not offering one.
    const example = structureOnly.slice(structureOnly.indexOf("```glaze-request"));
    expect(parseLogRequest(example)?.need).toEqual(["structure"]);
  });

  it("offers no request block when the run recorded nothing", () => {
    // The caller appends this unconditionally, so it is what keeps a bare
    // "```glaze-request" instruction out of a prompt nothing can honour. It is
    // also what stops `parseLogRequest` finding a fence to arm a send button
    // with — the assertion that actually matters, since a false positive there
    // offers to send page data on the strength of a prompt echo.
    const text = logRequestProtocol([]);
    expect(text).not.toContain("```glaze-request");
    expect(parseLogRequest(text)).toBeNull();
  });

  it("says what CANNOT be supplied when nothing was recorded", () => {
    // This used to be an empty string, and the silence was the bug. The system
    // prompt ends by inviting the model to say what more it needs; with no
    // protocol after it, what came back was "I need the HTML source code of
    // <url> at the time of failure" — unanswerable, since the run is over and
    // the app has no button that produces HTML. The session dead-ended there.
    const text = logRequestProtocol([]);
    expect(text).toContain("HTML");
    expect(text).toContain("screenshot");
    expect(text).toMatch(/do not ask/i);
  });

  it("tells the model to stop asking for screenshots and HTML in prose", () => {
    // The failure this whole need exists for: the system prompt's fallback
    // invites a prose ask, and the model spent its answer asking the user to
    // paste in a screenshot by hand.
    const text = logRequestProtocol(ALL_NEEDS);
    expect(text).toContain("REPLACES asking in prose");
    expect(text).toContain("screenshot");
  });
});

describe("describeNeed", () => {
  it("phrases each combination for the confirmation card", () => {
    expect(describeNeed(["console"])).toBe("the console output");
    expect(describeNeed(["network"])).toBe("the network activity");
    expect(describeNeed(["console", "network"])).toBe("the console output and network activity");
    expect(describeNeed(["structure"])).toBe("the page structure around the failing step");
    expect(describeNeed(["console", "network", "structure"])).toBe(
      "the console output, network activity and page structure around the failing step",
    );
  });
});
