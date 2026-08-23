// The TS-service child: the entry `utilityProcess.fork` runs. One language
// service (core.ts) answering requests over the parent port.
//
// Two transports, chosen by what exists: Electron's `process.parentPort`
// under the app, Node's IPC channel (`process.send`) when forked by plain
// Node — which is how `check:ts-service` boots THIS built file without
// Electron, and how a packaged layout's module resolution gets proven.
//
// `typescript` is resolved at runtime from the node_modules the parent names
// (`--node-modules=…`), the same tree `@playwright/test` is read from, so the
// bundle stays small and the compiler version is the one shipped with the app.

import { createRequire } from "node:module";
import * as path from "node:path";

import type { TsRequest, TsResponse } from "./protocol.js";

type Service = import("./core.js").TsService;

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : undefined;
}

const nodeModules = arg("node-modules") ?? path.resolve(process.cwd(), "node_modules");

type Port = { on(event: "message", fn: (e: { data: unknown }) => void): void; postMessage(m: unknown): void };
const parentPort = (process as unknown as { parentPort?: Port }).parentPort;

function send(m: TsResponse): void {
  if (parentPort) parentPort.postMessage(m);
  else if (process.send) process.send(m);
}

let servicePromise: Promise<Service> | null = null;
function service(): Promise<Service> {
  if (!servicePromise) {
    servicePromise = (async () => {
      // `core.ts` is bundled into this file; `typescript` is not. Make the
      // bundled core's `import ts from "typescript"` resolve from the tree
      // the parent named by putting it first on the module path.
      const { createTsService } = await import("./core.js");
      return createTsService({ nodeModules });
    })();
  }
  return servicePromise;
}

async function handle(req: TsRequest): Promise<unknown> {
  if (req.method === "ping") {
    const require = createRequire(path.join(nodeModules, "x.js"));
    const ts = require("typescript") as { version: string };
    await service();
    return { typescript: ts.version };
  }
  const svc = await service();
  switch (req.method) {
    case "update":
      return svc.update(req.params.id, req.params.text, req.params.runtime);
    case "close":
      return svc.close(req.params.id);
    case "diagnostics":
      return svc.diagnostics(req.params.id);
    case "completions":
      return svc.completions(req.params.id, req.params.offset);
    case "hover":
      return svc.hover(req.params.id, req.params.offset);
    case "inspections":
      return svc.inspections(req.params.id, req.params.enabled);
    case "format":
      return svc.format(req.params.id);
  }
}

function onMessage(raw: unknown): void {
  const req = raw as TsRequest;
  if (!req || typeof req !== "object" || typeof req.id !== "number") return;
  handle(req).then(
    (result) => send({ id: req.id, result: result ?? null }),
    (err) => send({ id: req.id, error: err instanceof Error ? err.message : String(err) }),
  );
}

if (parentPort) parentPort.on("message", (e) => onMessage(e.data));
else process.on("message", onMessage);
