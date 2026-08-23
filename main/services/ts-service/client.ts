// The main-process side of the TS service: forks the child, matches replies
// to requests, and says plainly when there is no service to ask.
//
// "Type intelligence unavailable" is a STATE, not an error. The editor works
// without it (Lezer syntax errors and the Playwright --list check stay), so a
// fork that fails — no Electron in tests, a broken install, a child that
// died three times — sets `status().available = false` with the reason, and
// every request answers empty. Nothing here may take the app down.
//
// The forker is injectable (`useForker`) so a test can run the child's logic
// in-process over the real typescript, and so the production path is the
// only place `utilityProcess` is touched.

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { logger, utilityProcess } from "@shell/backend";

import type { InspectionRule } from "./core.js";
import type { TsRequest, TsResponse, TsResults } from "./protocol.js";

type TsMethod = TsRequest["method"];
type TsParams = { [M in TsMethod]: Extract<TsRequest, { method: M }>["params"] };

export interface TsChildLike {
  postMessage(message: unknown): void;
  on(event: "message", fn: (message: unknown) => void): unknown;
  on(event: "exit", fn: (code: number) => void): unknown;
  kill(): void;
}

export type TsForker = (opts: { nodeModules: string }) => TsChildLike;

export interface TsServiceStatus {
  available: boolean;
  reason?: string;
  typescript?: string;
}

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESTARTS = 3;

let forker: TsForker | null = null;
let child: TsChildLike | null = null;
let starting: Promise<TsChildLike | null> | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let status: TsServiceStatus = { available: false, reason: "Not started." };
let restarts = 0;
/** Documents the renderer has opened, replayed into a restarted child. */
const open = new Map<string, { text: string; runtime?: string }>();

function childScript(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "ts-service.js");
}

function defaultForker({ nodeModules }: { nodeModules: string }): TsChildLike {
  const proc = utilityProcess.fork(childScript(), [`--node-modules=${nodeModules}`], { serviceName: "Good Looks! TypeScript" });
  return {
    postMessage: (m) => proc.postMessage(m),
    on: (event: "message" | "exit", fn: (x: never) => void) => {
      if (event === "message") proc.on("message", (m: unknown) => (fn as (m: unknown) => void)(m));
      else proc.on("exit", (code: number) => (fn as (c: number) => void)(code));
    },
    kill: () => void proc.kill(),
  };
}

function failAll(reason: string): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

async function nodeModulesDir(): Promise<string> {
  const { resolvePlaywright } = await import("../playwright-runner.js");
  return resolvePlaywright().nodeModules;
}

async function start(): Promise<TsChildLike | null> {
  if (child) return child;
  if (starting) return starting;
  starting = (async () => {
    try {
      const nodeModules = await nodeModulesDir();
      const c = (forker ?? defaultForker)({ nodeModules });
      c.on("message", (raw) => {
        const m = raw as TsResponse;
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        clearTimeout(p.timer);
        if ("error" in m) p.reject(new Error(m.error));
        else p.resolve(m.result);
      });
      c.on("exit", (code) => {
        if (child !== c) return;
        child = null;
        failAll(`The TypeScript service exited (${code}).`);
        restarts++;
        status = {
          available: false,
          reason: restarts > MAX_RESTARTS ? "The TypeScript service kept exiting; not restarting it." : `The TypeScript service exited (${code}); it restarts on the next request.`,
        };
        logger.warn("ts-service", "child exited", { code, restarts });
      });
      child = c;
      const pong = (await request(c, "ping", {})) as TsResults["ping"];
      status = { available: true, typescript: pong.typescript };
      // A restarted child knows nothing: hand it the open documents again.
      for (const [id, doc] of open) await request(c, "update", { id, text: doc.text, runtime: doc.runtime });
      logger.info("ts-service", "ready", { typescript: pong.typescript, nodeModules });
      return c;
    } catch (err) {
      child = null;
      status = { available: false, reason: err instanceof Error ? err.message : String(err) };
      logger.warn("ts-service", "unavailable", { reason: status.reason });
      return null;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

function request<M extends TsMethod>(c: TsChildLike, method: M, params: TsParams[M]): Promise<TsResults[M]> {
  const id = nextId++;
  return new Promise<TsResults[M]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`The TypeScript service did not answer "${method}" within ${REQUEST_TIMEOUT_MS}ms.`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    c.postMessage({ id, method, params } as unknown as TsRequest);
  });
}

async function ask<M extends TsMethod>(method: M, params: TsParams[M], empty: TsResults[M]): Promise<TsResults[M]> {
  if (restarts > MAX_RESTARTS) return empty;
  const c = await start();
  if (!c) return empty;
  try {
    return await request(c, method, params);
  } catch (err) {
    logger.warn("ts-service", "request failed", { method, err: String(err) });
    return empty;
  }
}

export const tsService = {
  /** Test hook: the production forker is `utilityProcess.fork`. */
  useForker(custom: TsForker | null): void {
    forker = custom;
  },

  status(): TsServiceStatus {
    return status;
  },

  /** Start (or confirm) the child; answers the status either way. */
  async ensure(): Promise<TsServiceStatus> {
    await start();
    return status;
  },

  async update(id: string, text: string, runtime?: string): Promise<void> {
    open.set(id, { text, runtime });
    await ask("update", { id, text, runtime }, undefined);
  },

  async close(id: string): Promise<void> {
    open.delete(id);
    await ask("close", { id }, undefined);
  },

  diagnostics(id: string): Promise<TsResults["diagnostics"]> {
    return ask("diagnostics", { id }, []);
  },

  completions(id: string, offset: number): Promise<TsResults["completions"]> {
    return ask("completions", { id, offset }, []);
  },

  hover(id: string, offset: number): Promise<TsResults["hover"]> {
    return ask("hover", { id, offset }, null);
  },

  inspections(id: string, enabled?: Partial<Record<InspectionRule, boolean>>): Promise<TsResults["inspections"]> {
    return ask("inspections", { id, enabled }, []);
  },

  format(id: string): Promise<TsResults["format"]> {
    return ask("format", { id }, []);
  },

  /** Stop the child (app quit, or a test's teardown). */
  stop(): void {
    const c = child;
    child = null;
    open.clear();
    failAll("The TypeScript service was stopped.");
    if (c) c.kill();
    status = { available: false, reason: "Stopped." };
  },

  /** Test hook: forget the restart count and the status. */
  resetForTesting(): void {
    this.stop();
    restarts = 0;
    status = { available: false, reason: "Not started." };
  },
};
