// Does the built TS-service child boot, find typescript and @playwright/test
// from a node_modules it is handed, and answer?
//
//   npm run check:ts-service
//
// `client.test.ts` runs the core in-process; `core.test.ts` imports it under
// Vitest's loader. Neither loads build/main/ts-service.js — the file
// `utilityProcess.fork` actually runs, bundled by esbuild with `typescript`
// external and resolved at runtime from `--node-modules=`. A packaged app
// where that resolution is wrong would show "type intelligence unavailable"
// on every Script tab while both tests stayed green. So this forks the built
// file under plain Node (the child speaks Node IPC when there is no
// parentPort) and asks it the same three things the editor does.

import { fork } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const built = path.join(root, "build", "main", "ts-service.js");
const nodeModules = path.join(root, "node_modules");

let failures = 0;
function assert(ok: boolean, label: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
}

if (!fs.existsSync(built)) {
  console.error(`FAIL ${built} is not built — run \`node scripts/build-main.mjs\` first`);
  process.exit(1);
}

const child = fork(built, [`--node-modules=${nodeModules}`], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
let nextId = 1;
const pending = new Map<number, (m: { result?: unknown; error?: string }) => void>();
child.on("message", (m: { id: number; result?: unknown; error?: string }) => pending.get(m.id)?.(m));
function ask(method: string, params: unknown): Promise<{ result?: unknown; error?: string }> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
    pending.set(id, (m) => {
      clearTimeout(t);
      resolve(m);
    });
    child.send({ id, method, params });
  });
}

const SPEC = 'import { test, expect } from "@playwright/test";\ntest("t", async ({ page }) => {\n  await page.\n});\n';

(async () => {
  try {
    const pong = await ask("ping", {});
    assert(!pong.error && typeof (pong.result as { typescript?: string })?.typescript === "string", `ping answers with a typescript version (${JSON.stringify(pong)})`);
    await ask("update", { id: "c", text: SPEC });
    const comp = await ask("completions", { id: "c", offset: SPEC.indexOf("page.") + 5 });
    const labels = ((comp.result as { label: string }[]) ?? []).map((c) => c.label);
    assert(labels.includes("goto") && labels.includes("getByRole"), `page. completes to Playwright's methods (${labels.length} entries)`);
    const diag = await ask("diagnostics", { id: "c" });
    assert(Array.isArray(diag.result) && (diag.result as unknown[]).length > 0, "a half-typed member is a diagnostic");
    const insp = await ask("inspections", { id: "c" });
    assert(Array.isArray(insp.result), "inspections answer with a list");
  } catch (err) {
    failures++;
    console.error("FAIL", err);
  } finally {
    child.kill();
  }
  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll ts-service checks passed.");
})();
