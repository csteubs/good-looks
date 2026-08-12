// Every backend→renderer push has somebody listening.
//
// WHY THIS EXISTS. A `sendToMain` with no `api.on` is the quietest bug this
// codebase produces. Nothing throws, nothing logs, every test passes, and the
// feature is simply absent — the backend does its work, hands the result to
// Electron, and Electron delivers it to a window that never asked for it. It
// has happened twice, and neither was found by anything in the toolchain:
//
//   • `trainerPanel:viewportNarrowed` — the trainer panel narrowed the training
//     browser by 360pt and the warning DECISIONS promised was never shown.
//   • `recorder:loadFailed` — the training window failed to open, the session
//     tore itself down, and the "Couldn't open the training browser" dialog
//     never appeared. It could not: the state field it was gated on is nulled
//     out before the broadcast, and the component hosting it is unmounted by
//     then. The push was the only carrier and had no listener.
//
// Both were found by hand, months apart, by grepping. This makes the grep a
// gate.
//
// NO ALLOWLIST, deliberately. An "expected orphans" list is precisely the
// artefact that would have hidden both of the above: the fix for a red check
// becomes "add the channel to the list", which is indistinguishable from the
// bug. If a push genuinely should have no consumer, it should not be a push —
// delete it, as `recorder:healSuggestion` was.
//
// ── The two ways this check could lie, both guarded ──────────────────
//
// 1. IT COULD FIND NOTHING. A regex that silently stops matching harvests an
//    empty channel set, and an empty set has no orphans — the check goes green
//    because it went blind. So the harvest is floored, and the specific
//    channels that exercise each parsing path are pinned by name.
//
// 2. IT COULD MISS A SEND. `sendToMain` is not always called with a literal:
//    `branch-switcher.ts` passes a `const`, and `batch-runner.ts` injects a
//    forwarder (`emit: (channel, payload) => sendToMain(channel, payload)`).
//    An indirection the scanner cannot follow must FAIL rather than be skipped,
//    or a channel drops out of the set and its orphan-hood with it.
//
// Run with: npm run check:push-consumers

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * Index just past the `(` that opens a call, skipping a generic argument list.
 *
 * The generic is the whole reason this is not a regex. `api.on` is routinely
 * written `api.on<{ status: "begin" | "end" }>("recorder:replayStep", …)`, and
 * a pattern that takes the first string literal after `api.on` reads `begin` as
 * the channel name. The subscription is then invisible to the check and its
 * channel is reported as an orphan — a false failure that sends whoever is
 * holding it looking for a bug in working code. Pinned below.
 *
 * Returns -1 when what follows is not a call (an import, a re-export, a bare
 * reference), which the callers treat as "not a send/subscribe site".
 */
function callOpenParen(src: string, i: number): number {
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] === "<") {
    let depth = 0;
    while (i < src.length) {
      if (src[i] === "<") depth++;
      else if (src[i] === ">") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      i++;
    }
  }
  while (i < src.length && /\s/.test(src[i])) i++;
  return src[i] === "(" ? i + 1 : -1;
}

/** The first argument when it is a string literal, else null. */
function firstStringArg(src: string, i: number): string | null {
  while (i < src.length && /\s/.test(src[i])) i++;
  const quote = src[i];
  if (quote !== '"' && quote !== "'") return null;
  let j = i + 1;
  let out = "";
  while (j < src.length && src[j] !== quote) {
    out += src[j];
    j++;
  }
  return out;
}

// ── What the backend pushes ──────────────────────────────────────────

/** channel → the file that sends it (for the failure message). */
const sent = new Map<string, string>();
/** A `sendToMain` whose channel could not be determined statically. */
const unresolved: { file: string; arg: string }[] = [];
/** Files that forward `sendToMain` through a parameter, and what they yielded. */
const forwarders = new Map<string, number>();

for (const file of walk("main")) {
  // Check scripts quote source they are asserting against, so their matches are
  // text about sends rather than sends. Scanning them finds `sendToMain(` inside
  // a string and reports an unresolvable channel that does not exist.
  if (file.includes("__tests__")) continue;
  const src = readFileSync(file, "utf8");

  const consts = new Map<string, string>();
  for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+?)?=\s*"([^"]+)"/g)) {
    consts.set(m[1], m[2]);
  }

  let forwards = false;
  for (const m of src.matchAll(/\bsendToMain\b/g)) {
    const at = m.index ?? 0;
    // The declaration in app-window.ts, not a call to it.
    if (/function\s+$/.test(src.slice(Math.max(0, at - 20), at))) continue;
    const open = callOpenParen(src, at + "sendToMain".length);
    if (open < 0) continue;

    const literal = firstStringArg(src, open);
    if (literal !== null) {
      sent.set(literal, file);
      continue;
    }
    const ident = src.slice(open).match(/^\s*([A-Za-z_$][\w$]*)\s*[,)]/);
    if (ident && consts.has(ident[1])) {
      sent.set(consts.get(ident[1])!, file);
      continue;
    }
    unresolved.push({ file, arg: ident ? ident[1] : src.slice(open, open + 30).trim() });
    forwards = true;
  }

  // A file that forwards the channel through a parameter has to name its
  // channels somewhere, and in every case so far that is a literal `emit(...)`
  // in the same file. Harvesting `emit(` repo-wide would be wrong — the script
  // generator has its own `emit` that writes assertion kinds — so this is scoped
  // to files that actually forward. A forwarder that yields nothing is a real
  // failure: it means channels are reaching the renderer that this cannot see.
  if (forwards) {
    let found = 0;
    for (const m of src.matchAll(/\bemit\s*\(\s*"([^"]+)"/g)) {
      sent.set(m[1], file);
      found++;
    }
    forwarders.set(file, found);
  }
}

// ── What the renderer listens to ─────────────────────────────────────

const heard = new Map<string, string>();
for (const file of walk("renderer")) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/\bapi\.on\b/g)) {
    const open = callOpenParen(src, (m.index ?? 0) + "api.on".length);
    if (open < 0) continue;
    const literal = firstStringArg(src, open);
    if (literal !== null && !heard.has(literal)) heard.set(literal, file);
  }
}

// ── The oracle has to be working ─────────────────────────────────────
//
// Every assertion below this point is vacuous against an empty harvest, so the
// harvest is checked first. The floors are deliberately well under the real
// counts (24 and 24 at the time of writing) — they catch a scanner that has
// stopped working, not a codebase that has grown or shrunk.

assert(sent.size >= 15, `harvested a plausible number of push channels (${sent.size})`);
assert(heard.size >= 15, `harvested a plausible number of subscriptions (${heard.size})`);

// One channel per parsing path, named, so a regression in any one of them is a
// specific failure rather than a mysterious orphan.
assert(sent.has("recorder:state"), "sees a plain string-literal sendToMain (recorder:state)");
assert(
  sent.has("branches:progress"),
  "resolves a sendToMain called with a const (branches:progress)",
);
assert(sent.has("batch:done"), "follows the batch-runner emit forwarder (batch:done)");
assert(
  heard.get("recorder:replayStep") !== undefined,
  "reads past a generic to the channel (recorder:replayStep, whose generic contains string literals)",
);

for (const [file, found] of forwarders) {
  assert(found > 0, `${file} forwards sendToMain and names its channels with emit("…")`);
}

// ── The properties ───────────────────────────────────────────────────

// A forwarder's own `sendToMain(channel, …)` is unresolvable BY DESIGN — the
// channel is its parameter. That is only acceptable because the loop above
// recovered the real names from `emit("…")` in the same file, so it counts as
// resolved exactly when that recovery found something. A forwarder that yielded
// nothing fails here AND on its own assertion above, which is the intent: two
// statements of the same missing fact, neither of which can be satisfied by
// listing a channel somewhere.
const stillUnresolved = unresolved.filter((u) => (forwarders.get(u.file) ?? 0) === 0);
assert(
  stillUnresolved.length === 0,
  stillUnresolved.length === 0
    ? `every sendToMain channel is statically resolvable (${forwarders.size} forwarder(s) recovered via emit)`
    : `every sendToMain channel is statically resolvable — cannot resolve ${stillUnresolved
        .map((u) => `${u.arg} in ${u.file}`)
        .join(", ")}. Make the channel a literal or a same-file const, or this check cannot tell whether it has a consumer.`,
);

const orphans = [...sent.keys()].filter((c) => !heard.has(c)).sort();
assert(
  orphans.length === 0,
  orphans.length === 0
    ? `every pushed channel has a renderer subscriber (${sent.size} channels)`
    : `every pushed channel has a renderer subscriber — nothing subscribes to ${orphans
        .map((c) => `"${c}" (sent from ${sent.get(c)})`)
        .join(", ")}. Give it an api.on, or delete the push; do NOT add it to an allowlist.`,
);

if (failures > 0) {
  console.error(`\n${failures} push-consumer check(s) failed.`);
  process.exit(1);
}
console.log("\nAll push-consumer checks passed.");
