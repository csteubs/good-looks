// API request steps. Three layers, each pinned: EMISSION (one helper line,
// every vocabulary re-checked independently of the boundary), ROUND-TRIP
// (the fixed key order reads back; anything foreign counts skipped), and the
// RUNTIME's semantics — the emitted glaze-runtime.mjs is imported as real JS
// and driven against a fake page, because "fails on 500 by default" is a
// meaning claim, not a source-shape claim.

import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

import { describe, expect, it } from "vitest";

import { generateSpec } from "./script-generator.js";
import { parseSpec } from "./spec-parser.js";
import { glazeRuntimeSource } from "../../shared/glaze-runtime-source.mjs";
import { normalizeRawStep } from "../recorder/types.js";
import type { Step, TestVariable } from "../recorder/types.js";

let seq = 0;
function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: `s${seq++}`, timestamp: 0, ...partial } as Step;
}

function gen(steps: Step[], variables: TestVariable[] = []): string {
  return generateSpec({ name: "t", url: "https://x.test", steps, variables } as Parameters<
    typeof generateSpec
  >[0]);
}

function shape(steps: Step[]): unknown[] {
  return steps.map(({ id: _i, timestamp: _t, ...rest }) => rest);
}

const FULL: Step = step({
  type: "api",
  apiMethod: "POST",
  url: "https://api.example.com/users",
  apiHeaders: { "Content-Type": "application/json", "X-Trace": "abc" },
  apiBody: '{"name":"Ada"}',
  expectStatus: 201,
  captureVar: "userId",
  capturePath: "data.id",
});

describe("emission", () => {
  it("emits one awaited helper line with the fixed key order", () => {
    const src = gen([FULL]);
    expect(src).toContain(
      'await glazeApiRequest(page, V, { method: "POST", url: "https://api.example.com/users", ' +
        'headers: { "Content-Type": "application/json", "X-Trace": "abc" }, ' +
        'body: "{\\"name\\":\\"Ada\\"}", expectStatus: 201, captureVar: "userId", capturePath: "data.id" });',
    );
    expect(src).toContain('import { glazeApiRequest } from "./glaze-runtime.mjs";');
    // The helper writes captures into V, so the header must exist even with
    // no declared variables.
    expect(src).toContain("const V = {");
  });

  it("omits every optional field on a minimal GET", () => {
    const src = gen([step({ type: "api", url: "https://x.test/health" })]);
    expect(src).toContain(
      'await glazeApiRequest(page, V, { method: "GET", url: "https://x.test/health" });',
    );
  });

  it("interpolates ${var} references through V", () => {
    const src = gen(
      [
        step({
          type: "api",
          url: "https://api.example.com/users/${userId}",
          apiHeaders: { Authorization: "Bearer ${token}" },
        }),
      ],
      [
        { name: "userId", kind: "plain", value: "1" },
        { name: "token", kind: "secret" },
      ],
    );
    expect(src).toContain("url: `https://api.example.com/users/${V.userId}`");
    expect(src).toContain('"Authorization": `Bearer ${V.token}`');
  });

  it("never interpolates a forged method — the generator allowlists independently", () => {
    const forged = step({ type: "api", url: "https://x.test/" });
    (forged as unknown as Record<string, unknown>).apiMethod = 'GET", url: "x"}); evil(); //';
    const src = gen([forged]);
    expect(src).toContain('method: "GET"');
    expect(src).not.toContain("evil()");
  });

  it("drops a header whose name breaks the token grammar or whose value carries CR/LF", () => {
    const forged = step({ type: "api", url: "https://x.test/" });
    (forged as unknown as Record<string, unknown>).apiHeaders = {
      'X-Ok': "fine",
      'Bad Name': "x",
      'X-Smuggle': "a\r\nX-Injected: b",
    };
    const src = gen([forged]);
    expect(src).toContain('"X-Ok": "fine"');
    expect(src).not.toContain("Bad Name");
    expect(src).not.toContain("X-Injected");
  });
});

describe("the boundary", () => {
  it("allowlists the method and rebuilds headers pair by pair", () => {
    const raw = normalizeRawStep({
      type: "api",
      url: "https://x.test/",
      apiMethod: "FETCH",
      apiHeaders: { "X-Ok": "v", "bad name": "v", "X-CRLF": "a\r\nb", 7: "v" },
    });
    expect(raw?.apiMethod).toBeUndefined();
    // "7" survives: digits are valid RFC 7230 token characters, odd as the
    // header looks. The space and the CR/LF are what the grammar exists for.
    expect(raw?.apiHeaders).toEqual({ "7": "v", "X-Ok": "v" });
  });

  it("bounds the status and validates the capture path grammar", () => {
    expect(normalizeRawStep({ type: "api", url: "u", expectStatus: 42 })?.expectStatus).toBeUndefined();
    expect(normalizeRawStep({ type: "api", url: "u", expectStatus: 204 })?.expectStatus).toBe(204);
    expect(
      normalizeRawStep({ type: "api", url: "u", capturePath: "data.items[0].id" })?.capturePath,
    ).toBe("data.items[0].id");
    expect(
      normalizeRawStep({ type: "api", url: "u", capturePath: "a..b" })?.capturePath,
    ).toBeUndefined();
  });
});

describe("round-trip", () => {
  it("reads the full field set back", () => {
    expect(shape(parseSpec(gen([FULL])))).toEqual(shape([FULL]));
  });

  it("reads the minimal form and var-referencing forms back", () => {
    const steps = [
      step({ type: "api", url: "https://x.test/health" }),
      step({ type: "api", apiMethod: "DELETE", url: "https://x.test/users/${userId}" }),
    ];
    const vars: TestVariable[] = [{ name: "userId", kind: "plain", value: "1" }];
    expect(shape(parseSpec(gen(steps, vars)))).toEqual(shape(steps));
  });

  it("round-trips disabled and continue-on-failure requests", () => {
    const a = step({ type: "api", url: "https://x.test/a", disabled: true });
    const b = step({ type: "api", url: "https://x.test/b", continueOnFailure: true });
    expect(shape(parseSpec(gen([a, b])))).toEqual(shape([a, b]));
  });

  it("regeneration is a fixed point", () => {
    const once = gen([FULL]);
    expect(gen(parseSpec(once))).toBe(once);
  });

  it("counts a hand-edited call with an unknown key as skipped, whole", () => {
    const src = gen([step({ type: "api", url: "https://x.test/" })]).replace(
      'url: "https://x.test/"',
      'url: "https://x.test/", retries: 3',
    );
    expect(parseSpec(src).some((s) => s.type === "api")).toBe(false);
  });
});

describe("the runtime helper", () => {
  async function loadRuntime(): Promise<{
    glazeApiRequest: (page: unknown, vars: Record<string, string>, opts: unknown) => Promise<void>;
  }> {
    const dir = mkdtempSync(join(tmpdir(), "gl-runtime-"));
    const file = join(dir, "glaze-runtime.mjs");
    writeFileSync(file, glazeRuntimeSource);
    return (await import(pathToFileURL(file).href)) as never;
  }

  function fakePage(status: number, body: string) {
    const calls: unknown[] = [];
    return {
      calls,
      page: {
        request: {
          fetch: async (url: string, opts: unknown) => {
            calls.push({ url, opts });
            return { status: () => status, text: async () => body };
          },
        },
      },
    };
  }

  it("passes on the expected status and captures through the JSON path", async () => {
    const rt = await loadRuntime();
    const { page } = fakePage(201, '{"data":{"id":"u-42"}}');
    const vars: Record<string, string> = {};
    await rt.glazeApiRequest(page, vars, {
      method: "POST",
      url: "https://x.test/users",
      expectStatus: 201,
      captureVar: "userId",
      capturePath: "data.id",
    });
    expect(vars.userId).toBe("u-42");
  });

  it("fails on a status mismatch, naming both statuses", async () => {
    const rt = await loadRuntime();
    const { page } = fakePage(500, "boom");
    await expect(
      rt.glazeApiRequest(page, {}, { method: "GET", url: "https://x.test/", expectStatus: 200 }),
    ).rejects.toThrow(/answered 500, expected 200/);
  });

  it("fails on 4xx/5xx even with no expected status — silence would hide the point", async () => {
    const rt = await loadRuntime();
    const { page } = fakePage(503, "down");
    await expect(
      rt.glazeApiRequest(page, {}, { method: "GET", url: "https://x.test/" }),
    ).rejects.toThrow(/failed with 503/);
  });

  it("captures the raw text when no path is given, and names a bad path or non-JSON body", async () => {
    const rt = await loadRuntime();
    const text = fakePage(200, "plain body");
    const vars: Record<string, string> = {};
    await rt.glazeApiRequest(text.page, vars, {
      method: "GET",
      url: "https://x.test/",
      captureVar: "raw",
    });
    expect(vars.raw).toBe("plain body");

    const notJson = fakePage(200, "<html>");
    await expect(
      rt.glazeApiRequest(notJson.page, {}, {
        method: "GET",
        url: "https://x.test/",
        captureVar: "x",
        capturePath: "a.b",
      }),
    ).rejects.toThrow(/not JSON/);

    const missing = fakePage(200, '{"a":{}}');
    await expect(
      rt.glazeApiRequest(missing.page, {}, {
        method: "GET",
        url: "https://x.test/",
        captureVar: "x",
        capturePath: "a.b.c",
      }),
    ).rejects.toThrow(/nothing at "a\.b\.c"/);
  });
});
