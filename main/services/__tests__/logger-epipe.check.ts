// Does the app SURVIVE the console it was logging to going away?
//
// THE BUG. A packaged Good Looks! put this in front of the user, over and over:
//
//     A JavaScript error occurred in the main process
//     Uncaught Exception: Error: write EPIPE   … at console.log … at log(…)
//
// `logger.log` wrote to the console unguarded. stdout is a SOCKET whenever the
// app was launched by another process — a terminal, a script, an agent's shell
// — and when that parent exits and the app does not, every later log line
// writes to a dead pipe.
//
// WHY THIS IS A CHECK AND NOT A VITEST CASE. The failure arrives from the event
// loop of a process whose parent has exited. Nothing in-process can produce
// that: you need a real child, really orphaned, really still writing. A mocked
// stream proves the handler is attached (stdio-guard.test.ts does that) and
// says nothing about whether the app lives — which is the whole question, and
// is exactly the gap `check:mcp-boot` was written for on the neighbouring
// problem: a suite that only inspects a program cannot tell you it is a corpse.
//
// It deliberately exercises the SHAPE the logger uses rather than importing
// `logger.ts`, which imports `electron` and cannot be loaded outside an Electron
// process. The source assertions at the bottom are what tie the proven
// mechanism to the code that actually runs.
//
//   npm run check:logger-epipe

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { guardStdio, writeSafely } from "../../shell/stdio-guard.js";

let failures = 0;
function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-epipe-"));

/**
 * Run a child that logs on a timer, orphan it, and report what happened.
 *
 * The child writes its verdict to a FILE. It cannot tell us on stdout — stdout
 * is the thing under test, and by the time there is anything to report it is
 * broken.
 */
function orphanedWriter(guarded: boolean): Promise<string> {
  const tag = guarded ? "guarded" : "bare";
  const resultFile = path.join(dir, `result-${tag}.txt`);
  const childFile = path.join(dir, `child-${tag}.mjs`);
  const launchFile = path.join(dir, `launch-${tag}.mjs`);

  fs.writeFileSync(
    childFile,
    `
import fs from "node:fs";
import process from "node:process";
const say = (m) => { try { fs.appendFileSync(${JSON.stringify(resultFile)}, m + "\\n"); } catch {} };
process.on("uncaughtException", (e) => { say("UNCAUGHT:" + e.code); process.exit(9); });
${
  guarded
    ? `for (const s of [process.stdout, process.stderr]) { if (s && typeof s.on === "function") s.on("error", () => {}); }
const write = (fn, t) => { try { fn(t); } catch {} };`
    : `const write = (fn, t) => fn(t);`
}
let n = 0;
const timer = setInterval(() => {
  n++;
  write(console.log, "line " + n);
  if (n >= 25) { say("SURVIVED:" + n); clearInterval(timer); process.exit(0); }
}, 20);
`,
    "utf-8",
  );

  // A SHORT-LIVED LAUNCHER, and it is the whole trick. Destroying the read end
  // from this process does not break the pipe — Node keeps buffering and the
  // child writes on happily, which is how a first draft of this check passed
  // while proving nothing. What actually produces EPIPE is the owning process
  // EXITING, so the writer has to be orphaned by a parent that goes away, and
  // that parent cannot be the check itself: the check has to stay alive to read
  // the verdict.
  fs.writeFileSync(
    launchFile,
    `
import { spawn } from "node:child_process";
import process from "node:process";
const child = spawn(process.execPath, [${JSON.stringify(childFile)}], {
  stdio: ["ignore", "pipe", "ignore"],
  detached: true,
});
child.unref();
// Long enough for one write to land down a healthy pipe, so the child is
// demonstrably working before the socket dies under it.
setTimeout(() => process.exit(0), 120);
`,
    "utf-8",
  );

  return new Promise((resolve) => {
    spawn(process.execPath, [launchFile], { stdio: "ignore" });
    // Poll for the verdict: the writer outlives its launcher, so there is no
    // process this check can await.
    const deadline = Date.now() + 8000;
    const poll = setInterval(() => {
      let text = "";
      try {
        text = fs.readFileSync(resultFile, "utf-8");
      } catch {
        /* not written yet */
      }
      if (/SURVIVED|UNCAUGHT/.test(text)) {
        clearInterval(poll);
        resolve(text.trim());
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        resolve(text.trim() || "(timed out with no verdict)");
      }
    }, 50);
  });
}

async function main(): Promise<void> {
  // 1. The mechanism, for real.
  const guarded = await orphanedWriter(true);
  assert(
    guarded.includes("SURVIVED"),
    `a guarded writer keeps running after its console dies (got ${JSON.stringify(guarded)})`,
  );
  assert(
    !guarded.includes("UNCAUGHT"),
    "…and raises no uncaught exception, which is what reached the user as a dialog",
  );

  // 2. THE CONTROL. Without this the check could pass because the harness never
  //    manages to break the pipe, and would then go on passing after a
  //    regression. The unguarded shape must actually die.
  const bare = await orphanedWriter(false);
  assert(
    bare.includes("UNCAUGHT"),
    `the UNGUARDED shape really does die here, so the test above is not vacuous (got ${JSON.stringify(bare)})`,
  );

  // 3. In-process: the exported guard behaves on a stream that is missing, the
  //    state a detached-stdio launch actually produces.
  let threw = false;
  try {
    guardStdio([null, undefined]);
    writeSafely(() => {
      throw new Error("write EPIPE");
    }, "x");
  } catch {
    threw = true;
  }
  assert(!threw, "guardStdio tolerates absent streams and writeSafely swallows a sync throw");

  // 4. Tie the proven mechanism to the code that runs. The shape above is only
  //    evidence about the app if the app's logger actually uses it — and the
  //    bug was precisely a bare console call sitting next to a guarded one.
  const loggerSrc = fs.readFileSync(
    path.resolve(process.cwd(), "main/shell/logger.ts"),
    "utf-8",
  );
  assert(
    /guardStdio\(\)/.test(loggerSrc),
    "logger installs the stream guard at module load",
  );
  assert(
    /writeSafely\(/.test(loggerSrc),
    "logger routes its console write through writeSafely",
  );
  // The regression this forbids is the original line coming back: a console
  // call that is not wrapped. Comments are stripped so the header's quotation
  // of the old code cannot satisfy it.
  const code = loggerSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const bareConsole = /(^|[^(\s])\s*console\.(log|warn|error)\(/m.test(code);
  assert(!bareConsole, "no bare console call is left in the logger");

  fs.rmSync(dir, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll logger-EPIPE checks passed.");
}

void main();
