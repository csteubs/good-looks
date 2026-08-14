// Does the MCP server actually START?
//
// THE CHECK THAT WOULD HAVE CAUGHT SIX MONTHS OF NOTHING. From the SDK port
// (2026-08-08) until 2026-08-14 the server threw at module load —
// `glaze-data.mjs` wanted a `package.json` `id` the port had removed — so every
// one of its tools was unreachable from any client. The whole time,
// `check:mcp-parity` and `check:mcp-select` were green: they read the source and
// import the pure modules, neither of which requires the thing to run.
//
// So this one runs it. A real child process, a real stdio JSON-RPC handshake, a
// real `tools/list`. Nothing here inspects source; the only question it asks is
// the one no other check could: does a client get a usable server.
//
// It drives the server through `GOOD_LOOKS_USERDATA` at a throwaway store, which
// is also what makes it work off macOS — the app is a mac app, but a check that
// can only run on someone's laptop is a check CI cannot have.
//
//   npm run check:mcp-boot

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { fileURLToPath } from "node:url";

const MCP_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(MCP_DIR, "server.mjs");

let failures = 0;
function assert(condition, label) {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

/** A throwaway data directory with just enough in it to be a store. */
function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-mcp-boot-"));
  fs.mkdirSync(path.join(dir, "recorder"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "recorder", "tests.json"),
    JSON.stringify([
      { id: "t-a", name: "A", url: "https://example.test", steps: [], group: "Storefront" },
      { id: "t-b", name: "B", url: "https://example.test", steps: [] },
    ]),
  );
  return dir;
}

/** Speak stdio JSON-RPC to the server directly rather than through the SDK's
 *  client. The point is to prove a CLIENT can talk to it, and a hand-rolled
 *  handshake has no version coupling to the SDK the server itself imports —
 *  which would make this check pass or fail for reasons that are not the
 *  server's. */
function callServer(store, requests) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, GOOD_LOOKS_USERDATA: store },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const done = (result) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(result);
    };
    const timer = setTimeout(() => done({ out, err, timedOut: true }), 20_000);

    child.stdout.on("data", (d) => {
      out += d.toString();
      // Every request answered? The server writes one JSON line per response.
      if (out.split("\n").filter((l) => l.trim().startsWith("{")).length >= requests.length) {
        done({ out, err, timedOut: false });
      }
    });
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => done({ out, err: `${err}${e}`, timedOut: false }));
    child.on("exit", (code) => done({ out, err, exitCode: code, timedOut: false }));

    for (const req of requests) child.stdin.write(`${JSON.stringify(req)}\n`);
  });
}

function parseResponses(out) {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const store = makeStore();
try {
  const { out, err, timedOut } = await callServer(store, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "check:mcp-boot", version: "0" },
      },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);

  assert(!timedOut, "the server answers rather than hanging");
  // Named explicitly: a server that died at import writes its reason here, and
  // reporting "no tools" for that would send someone to look at the registry.
  assert(
    !/Error:|not defined|Cannot find/.test(err),
    `the server starts without throwing${err ? ` — stderr said: ${err.split("\n")[0]}` : ""}`,
  );

  const responses = parseResponses(out);
  const initialize = responses.find((r) => r.id === 1);
  assert(initialize?.result?.serverInfo?.name !== undefined, "it completes the initialize handshake");

  const tools = responses.find((r) => r.id === 2)?.result?.tools ?? [];
  // A floor rather than an exact count: this check is about the server being
  // reachable, and pinning the number would make it fail every time a tool is
  // added, which trains people to edit it without reading it.
  assert(tools.length >= 20, `it serves its tools over the wire (got ${tools.length})`);

  const names = new Set(tools.map((t) => t.name));
  // One read, one write, one of each recent addition — so a registration that
  // throws mid-file is caught rather than leaving a truncated list that still
  // clears the floor above.
  for (const name of ["list_tests", "run_batch", "run_group", "run_routine", "list_routines"]) {
    assert(names.has(name), `…including ${name}`);
  }
} finally {
  fs.rmSync(store, { recursive: true, force: true });
}

// ── The failure path is a message, not a stack ────────────────────────────
//
// `--print-data-dir` is the one diagnostic a user has when this goes wrong, and
// it used to sit BELOW an unguarded resolve at module scope — so the command
// that explains the failure died of it. What a reader gets has to be the
// sentence, not a trace from inside node_modules.
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "gl-mcp-nostore-"));
  const res = spawnSyncish(empty);
  assert(res.status === 1, "a server with no store exits non-zero rather than pretending");
  assert(
    /No data directory found/.test(res.stderr) && !/at \w+ \(/.test(res.stderr),
    "…and says so in a sentence rather than a stack trace",
  );
  assert(
    res.stderr.includes("GOOD_LOOKS_USERDATA"),
    "…and names the override, which is the way out",
  );
  fs.rmSync(empty, { recursive: true, force: true });
}

/** `--print-data-dir` against a directory chosen to have no store, with the
 *  override pointed at nothing. Synchronous because there is no handshake. */
function spawnSyncish(emptyDir) {
  return spawnSync(process.execPath, [SERVER, "--print-data-dir"], {
    encoding: "utf8",
    env: {
      ...process.env,
      GOOD_LOOKS_USERDATA: "",
      HOME: emptyDir,
      XDG_CONFIG_HOME: path.join(emptyDir, "config"),
    },
  });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll mcp-boot checks passed");
