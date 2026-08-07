// Dev harness: starts the Vite dev server, builds main+preload once, then
// launches Electron pointed at the dev server via GOOD_LOOKS_DEV_URL.
// window-paths.ts prefers that env var over the built HTML files.

import { spawn } from "node:child_process";
import { createServer } from "vite";

const vite = await createServer();
await vite.listen();
const address = vite.httpServer.address();
const devUrl = `http://localhost:${address.port}`;
console.log(`[dev] renderer at ${devUrl}`);

// Main + preload still need a real build — Electron can't execute TS.
const build = spawn("node", ["scripts/build-main.mjs"], { stdio: "inherit" });
await new Promise((resolve, reject) => {
  build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build-main exited ${code}`))));
});

const electron = spawn("npx", ["electron", "."], {
  stdio: "inherit",
  env: { ...process.env, GOOD_LOOKS_DEV_URL: devUrl },
});
electron.on("exit", (code) => {
  void vite.close().then(() => process.exit(code ?? 0));
});
