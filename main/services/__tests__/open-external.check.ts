// What the app will and will not hand to the operating system.
//
// `shell.openExternal` launches whatever Launch Services has registered for a
// scheme, so the validator in `main/shell/external-url.ts` is the whole of the
// boundary between "a URL that came back from api.github.com" and "a program
// running on this Mac with an argument the network chose". A boundary with one
// caller is exactly the kind that gets widened by someone fixing an unrelated
// bug, so the hostile cases are pinned here by name.
//
// Run against the REAL module rather than a transcription of its rules: the
// failure this catches is the module changing, and a copy of the rules would
// still pass. It imports nothing, so `tsx` can load it directly — no esbuild
// bundle and no `@shell/backend` stub needed.
//
// Run with: npm run check:open-external

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { checkExternalUrl, externalUrlProblem } from "../../shell/external-url.js";

const root = process.cwd();

/** The one channel this feature rides on. */
const CHANNEL = "shell:openExternal";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

/** Rejected, AND the refusal says something. A `null`-vs-string API where the
 *  string is empty logs a blank line and tells nobody anything. */
function refuses(url: unknown, label: string): void {
  const problem = externalUrlProblem(url);
  assert(typeof problem === "string" && problem.length > 0, `refuses ${label}`);
}

function accepts(url: string, label: string): void {
  const problem = externalUrlProblem(url);
  assert(problem === null, `accepts ${label}${problem ? ` — got: ${problem}` : ""}`);
}

// ── What the feature actually needs ───────────────────────────────────
//
// A pull request's `html_url`, and the shapes GitHub really produces around it.
accepts("https://github.com/csteubs/good-looks/pull/88", "a pull request URL");
accepts("https://github.com/csteubs/good-looks/tree/branch-hover", "a branch URL");
accepts("https://github.com/csteubs/good-looks/pull/88#issuecomment-1", "a fragment");
accepts("https://github.com/o/r/compare/main...feat%2Fx?expand=1", "an escaped query");
accepts("https://api.github.com/repos/o/r", "a github.com subdomain");
accepts("https://GitHub.com/o/r/pull/1", "a host in mixed case");

// ── The four host traps ───────────────────────────────────────────────
//
// Each one passes a check somebody would plausibly write instead.
refuses("https://github.com.evil.com/o/r/pull/1", "github.com as someone else's label (startsWith)");
refuses("https://evilgithub.com/o/r/pull/1", "a host merely ENDING in github.com (endsWith)");
refuses("https://github.com@evil.com/pull/1", "userinfo hiding the real host");
refuses("https://user:pw@github.com/o/r", "credentials, even on the right host");
refuses("http://github.com/o/r/pull/1", "cleartext http, even on the right host");

// A near-miss on the label boundary: the allowlist appends a dot for a reason.
refuses("https://notgithub.com/o/r", "a longer host sharing the suffix");
refuses("https://github.como/o/r", "a host one character past the match");

// ── Schemes the OS would act on ───────────────────────────────────────
refuses("file:///etc/passwd", "file:, which opens Finder or a document");
refuses("file:///Applications/Calculator.app", "file: pointing at an application");
refuses("javascript:alert(1)", "javascript:");
refuses("data:text/html,<script>x</script>", "data:");
refuses("ms-msdt:/id", "a scheme another installed app may have registered");
refuses("vscode://file/etc/passwd", "a custom app scheme");
refuses("app://main-window.html", "this app's OWN scheme");

// ── Non-URLs and non-strings ──────────────────────────────────────────
//
// The renderer sends whatever it sends; the handler is typed but IPC is not.
refuses("", "an empty string");
refuses("github.com/o/r", "a bare host with no scheme");
refuses(undefined, "undefined");
refuses(null, "null");
refuses(42, "a number");
refuses({ toString: () => "https://github.com/o/r" }, "an object that stringifies to a good URL");
refuses(["https://github.com/o/r"], "an array");
refuses(`https://github.com/o/r/${"x".repeat(4000)}`, "a URL past the length cap");

// ── What is opened is what was checked ────────────────────────────────
//
// The bug this pins is not a rejection that should have been an acceptance —
// it is validating one value and opening another. The WHATWG parser normalises
// input, so a caller that checks `new URL(x)` and then opens `x` has examined
// something other than what the OS receives. `checkExternalUrl` hands back the
// href it approved so there is only one value in play; these are the inputs
// where the two differ.
function normalisesTo(input: string, href: string, label: string): void {
  const verdict = checkExternalUrl(input);
  assert(verdict.ok && verdict.href === href, `${label} → ${href}`);
}

// Leading whitespace is stripped by the parser, so the raw string and the
// parsed URL are different values. Accepting is correct; opening the RAW one
// would mean the host test ran against a string nobody opens.
normalisesTo("   https://github.com/o/r", "https://github.com/o/r", "leading whitespace");
normalisesTo("https://GitHub.com/o/r", "https://github.com/o/r", "a mixed-case host");
normalisesTo("https://github.com/a/../o/r", "https://github.com/o/r", "a dot segment");
normalisesTo("https://github.com:443/o/r", "https://github.com/o/r", "the default port");

// And the reason-only wrapper never disagrees with the verdict it delegates to.
for (const url of [
  "https://github.com/o/r/pull/1",
  "http://github.com/o/r",
  "file:///etc/passwd",
  "https://github.com.evil.com/",
  "",
]) {
  const verdict = checkExternalUrl(url);
  assert(
    externalUrlProblem(url) === (verdict.ok ? null : verdict.problem),
    `externalUrlProblem agrees with checkExternalUrl for ${JSON.stringify(url).slice(0, 40)}`,
  );
}

// ── Both ends agree on the channel name ───────────────────────────────
//
// The preload's shell methods end in `.catch(() => {})`, which is right — a
// renderer has nothing useful to do when the OS declines — and it means a typo
// in EITHER file produces a button that does nothing, with no error in either
// console and nothing in the main log. The two names are read out of the two
// files rather than compared to a constant here, because a constant is a third
// place to make the same typo.
const preload = readFileSync(join(root, "renderer/preload.ts"), "utf8");
const handlers = readFileSync(join(root, "main/shell/host-handlers.ts"), "utf8");

assert(
  preload.includes(`ipcRenderer.invoke("${CHANNEL}"`),
  `the preload invokes ${CHANNEL}`,
);
assert(
  handlers.includes(`ipcMain.handle("${CHANNEL}"`),
  `host-handlers registers ${CHANNEL}`,
);
// The whole point of the seam: the handler must not reach `shell.openExternal`
// without going through the validator first.
assert(
  handlers.includes("checkExternalUrl"),
  "the openExternal handler validates before opening",
);
assert(
  !/shell\.openExternal\(url\)/.test(handlers),
  "the handler opens the CHECKED href, never the raw argument it was passed",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll open-external checks passed.");
