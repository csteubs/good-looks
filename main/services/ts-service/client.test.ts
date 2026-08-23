// The client over an IN-PROCESS child: the real core and the real typescript,
// behind a forker that dispatches messages without a process. What the test
// is about is the client's own contract — status, replay after an exit,
// empty answers when there is nothing to ask, and a fork that throws.

import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTsService } from "./core.js";
import { tsService, type TsChildLike } from "./client.js";
import type { TsRequest } from "./protocol.js";

const NODE_MODULES = path.resolve(__dirname, "..", "..", "..", "node_modules");

/** A child that answers from the core in this process. `exit()` simulates
 *  the process dying; `drop` makes it swallow requests. */
function inProcessChild(): TsChildLike & { exit(code: number): void; drop: boolean; seen: string[] } {
  const svc = createTsService({ nodeModules: NODE_MODULES });
  const listeners = { message: [] as ((m: unknown) => void)[], exit: [] as ((c: number) => void)[] };
  const child = {
    drop: false,
    seen: [] as string[],
    postMessage(raw: unknown) {
      const req = raw as TsRequest;
      child.seen.push(req.method);
      if (child.drop) return;
      let result: unknown = null;
      switch (req.method) {
        case "ping": result = { typescript: "in-process" }; break;
        case "update": svc.update(req.params.id, req.params.text, req.params.runtime); break;
        case "close": svc.close(req.params.id); break;
        case "diagnostics": result = svc.diagnostics(req.params.id); break;
        case "completions": result = svc.completions(req.params.id, req.params.offset); break;
        case "hover": result = svc.hover(req.params.id, req.params.offset); break;
        case "inspections": result = svc.inspections(req.params.id, req.params.enabled); break;
      }
      queueMicrotask(() => listeners.message.forEach((fn) => fn({ id: req.id, result })));
    },
    on(event: "message" | "exit", fn: (x: never) => void) {
      (listeners[event] as ((x: never) => void)[]).push(fn);
    },
    kill() {},
    exit(code: number) {
      listeners.exit.forEach((fn) => fn(code));
    },
  };
  return child;
}

const SPEC = 'import { test } from "@playwright/test";\ntest("t", async ({ page }) => {\n  await page.goto("https://a.example");\n});\n';

beforeEach(() => tsService.resetForTesting());
afterEach(() => {
  tsService.useForker(null);
  tsService.resetForTesting();
});

describe("tsService client", () => {
  it("is unavailable with the reason when the fork throws, and answers empty", async () => {
    tsService.useForker(() => {
      throw new Error("no electron here");
    });
    expect(await tsService.ensure()).toEqual({ available: false, reason: "no electron here" });
    await tsService.update("t1", SPEC);
    expect(await tsService.diagnostics("t1")).toEqual([]);
    expect(await tsService.completions("t1", 10)).toEqual([]);
    expect(await tsService.hover("t1", 10)).toBeNull();
  });

  it("forks once, reports ready, and answers through the child", async () => {
    const children: ReturnType<typeof inProcessChild>[] = [];
    tsService.useForker(() => {
      const c = inProcessChild();
      children.push(c);
      return c;
    });
    await tsService.update("t1", SPEC.replace("goto", "gotto"));
    const d = await tsService.diagnostics("t1");
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain("gotto");
    expect(tsService.status()).toEqual({ available: true, typescript: "in-process" });
    expect(children).toHaveLength(1);
    expect(children[0].seen[0]).toBe("ping");
  });

  it("after the child exits, the next request restarts it and replays the open documents", async () => {
    const children: ReturnType<typeof inProcessChild>[] = [];
    tsService.useForker(() => {
      const c = inProcessChild();
      children.push(c);
      return c;
    });
    await tsService.update("t1", SPEC);
    children[0].exit(1);
    expect(tsService.status().available).toBe(false);
    // The restarted child has never seen t1, yet answers about it.
    const labels = (await tsService.completions("t1", SPEC.indexOf("page.goto") + "page.".length)).map((c) => c.label);
    expect(labels).toContain("goto");
    expect(children).toHaveLength(2);
    expect(children[1].seen.slice(0, 2)).toEqual(["ping", "update"]);
    expect(tsService.status().available).toBe(true);
  });

  it("a request the child never answers times out to an empty answer", async () => {
    vi.useFakeTimers();
    try {
      const c = inProcessChild();
      tsService.useForker(() => c);
      await tsService.ensure();
      c.drop = true;
      const p = tsService.diagnostics("t1");
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await p).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
