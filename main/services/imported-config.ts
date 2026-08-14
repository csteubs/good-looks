// What an imported spec inherited from its own project's playwright.config,
// and cannot run without here.
//
// An imported spec is copied verbatim (see `import-service.ts`) and then run
// under THIS app's generated config, which is one shared file for every test.
// So everything the original config supplied silently disappears — and the one
// field that takes the suite down with it is `use.baseURL`. A suite whose
// navigations are relative (`page.goto("/")`, which is the idiomatic way to
// write them WITH a baseURL) has nothing to resolve against, and Playwright
// fails in the protocol layer with an error that names neither the config nor
// the missing field. That failure cost a whole AI-debug session to read.
//
// THE CONFIG IS NEVER EVALUATED. It is untrusted input on exactly the path
// `import-service.ts` already guards: importing is the moment the user believes
// they are only LOOKING, and `import()`ing a `playwright.config.ts` from a
// stranger's repository would execute it right then — before a single test has
// been run, and with none of the sandboxing a run gets. So this reads the file
// as text and lifts string literals out of it. The cost is real and accepted:
// a config that computes its base URL (from a `.env`, a helper, a ternary on
// `process.env.CI`) yields nothing here. That case is answered by letting the
// user type the URL in, not by getting cleverer with the parser.

import * as fs from "fs";
import * as path from "path";

/** The filenames Playwright itself looks for, and the only ones read here. */
export const PLAYWRIGHT_CONFIG_NAMES = [
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.mts",
  "playwright.config.mjs",
  "playwright.config.cts",
  "playwright.config.cjs",
];

/** How far above the scanned folder to keep looking for a config.
 *
 *  The folder the user picks is routinely the `tests/` directory, while the
 *  config sits beside `package.json` one level up — that is the layout of the
 *  suite this was written against, and of most Playwright projects. Refusing to
 *  look up would mean the common case finds nothing.
 *
 *  Bounded rather than unbounded because "walk up until something matches" ends
 *  at the filesystem root, and a stray `playwright.config.ts` in a home
 *  directory is not this project's config. */
const MAX_LEVELS_ABOVE_ROOT = 3;

/** Files that mark a directory as the top of a project. The walk stops after
 *  checking one, because a config above a package boundary belongs to something
 *  else. */
const PROJECT_MARKERS = ["package.json", ".git"];

/** A config's contents, as far as we are willing to read them. */
export interface ImportedProjectConfig {
  /** Absolute path of the config file the values came from. */
  configPath: string;
  /** `use.baseURL`, when it was written as a string literal. */
  baseUrl?: string;
  /** Top-level `timeout`, in ms, when it was written as a numeric literal. */
  timeoutMs?: number;
  /** Config features this app does not honour, named for the import summary. */
  unsupported: string[];
}

/** A path with symlinks resolved.
 *
 *  A path that does not exist cannot be realpath'd, so the nearest ancestor
 *  that DOES exist is resolved instead and the remainder joined back on. The
 *  plain `path.resolve` fallback was subtly wrong in the one place this is
 *  used: it left the spec dir unresolved while the scan root was resolved, so
 *  on macOS (`/var` → `/private/var`) the two shared no prefix and the walk
 *  counted its first step as already being above the root — reintroducing the
 *  exact trap the caller's comment says it avoids. */
function realOrSelf(p: string): string {
  const abs = path.resolve(p);
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return abs; // nothing along the path exists
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

function existsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function hasProjectMarker(dir: string): boolean {
  return PROJECT_MARKERS.some((m) => {
    try {
      return fs.existsSync(path.join(dir, m));
    } catch {
      return false;
    }
  });
}

/**
 * Find the playwright config governing `specDir`, searching upward.
 *
 * Walks from the spec's own directory up through `scanRoot`, then up to
 * `MAX_LEVELS_ABOVE_ROOT` further, stopping at the first directory that holds
 * a config — or one level after a project marker (`package.json` / `.git`),
 * whichever comes first.
 *
 * Reading above the folder the user picked is deliberate, and it is a weaker
 * act than the sibling copy `import-service.ts` bounds so carefully: the
 * filename is fixed and ours, not text from a file the importer wrote, nothing
 * is copied anywhere, and nothing is executed. What comes back out is a URL
 * string that gets validated before use.
 */
export function findProjectConfig(specDir: string, scanRoot: string): string | null {
  // Resolve BOTH sides through symlinks before comparing them. On macOS a temp
  // dir resolves /var → /private/var, so a resolved spec path judged against an
  // unresolved root shares no prefix with it — every directory then counts as
  // "above the root" and the walk gives up levels early, in exactly the layout
  // the tests run under. Same trap as `copyRelativeImports`, same fix.
  let dir = realOrSelf(specDir);
  const root = realOrSelf(scanRoot);
  let levelsAboveRoot = 0;

  for (;;) {
    // Counted BEFORE the directory is read, so the constant means what it says:
    // three directories above the scan root are searched, and the fourth is
    // not. Counting after the read searched one more than the name promises,
    // which is the kind of drift nobody notices until they are reasoning about
    // how far this reaches.
    if (!(dir === root || isUnder(root, dir))) {
      levelsAboveRoot += 1;
      if (levelsAboveRoot > MAX_LEVELS_ABOVE_ROOT) return null;
    }
    for (const name of PLAYWRIGHT_CONFIG_NAMES) {
      const candidate = path.join(dir, name);
      if (existsFile(candidate)) return candidate;
    }
    // A config lives at a project's top, so a directory holding `package.json`
    // is the last one worth checking.
    if (hasProjectMarker(dir)) return null;

    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

function isUnder(parent: string, child: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return c === p || c.startsWith(p + path.sep);
}

/** `use.baseURL` written as a plain string literal, optionally behind an
 *  env-var fallback (`process.env.BASE_URL || "https://example.com"`), which is
 *  how most checked-in configs express a default. Nothing else is recognised —
 *  see the file header for why the parser stays this dumb. */
const BASE_URL_RE =
  /\bbaseURL\s*:\s*(?:process\.env\.[A-Za-z_$][\w$]*\s*(?:\|\||\?\?)\s*)?(['"`])([^'"`\n]*)\1/;

/** A top-level `timeout:` inside the exported config object. Anchored to a
 *  two-space indent so it cannot match the `timeout` nested under `expect` or
 *  `use`, which mean entirely different things. */
const TEST_TIMEOUT_RE = /^ {2}timeout\s*:\s*([\d_]+)\s*,?\s*$/m;

/** An hour. A per-test timeout beyond this is a config we don't understand,
 *  and adopting it would hang a run the user is watching. */
const MAX_ADOPTED_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Lift `use.baseURL` out of config source.
 *
 * Returns null unless the value is a literal that parses as an http(s) URL.
 * A template literal with a `${…}` in it is not a literal for this purpose —
 * the regex refuses to match across one, and anything left that fails
 * `new URL` (a bare host, an empty string, a `file:` or `javascript:` scheme)
 * is dropped rather than guessed at.
 */
export function extractBaseUrl(source: string): string | null {
  const m = stripComments(source).match(BASE_URL_RE);
  if (!m) return null;
  return normalizeBaseUrl(m[2]);
}

/**
 * Config source with its comments removed.
 *
 * A commented-out line is the one thing a text-matching parser gets confidently
 * wrong. Configs collect them — the staging URL somebody switched away from
 * sits directly above the live one, and taking the FIRST match adopts it, then
 * stores it as trusted and navigates there. Same for a `webServer` block
 * commented out months ago, which would otherwise be reported as a feature the
 * import cannot honour.
 *
 * String-aware, because `"https://example.com"` contains `//` and a stripper
 * that doesn't know that deletes the rest of the line the base URL is ON.
 */
export function stripComments(source: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n"; // keep line structure — the timeout regex is line-anchored
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** The one place a base URL becomes trusted, wherever it came from — a parsed
 *  config or a field the user typed. Both go through this. */
export function normalizeBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.includes("${")) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.href;
}

/** Lift a top-level `timeout` (ms) out of config source, if it is a numeric
 *  literal within a range worth adopting. */
export function extractTestTimeoutMs(source: string): number | null {
  const m = stripComments(source).match(TEST_TIMEOUT_RE);
  if (!m) return null;
  const ms = Number(m[1].replace(/_/g, ""));
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_ADOPTED_TIMEOUT_MS) return null;
  return ms;
}

/** Config features that change what a run MEANS and that this app does not
 *  reproduce. Named so the import can say so, rather than letting the user
 *  discover it as a failure. */
const UNSUPPORTED_FEATURES: { re: RegExp; label: string }[] = [
  { re: /\bwebServer\s*:/, label: "webServer (this app cannot start your dev server)" },
  { re: /\bglobalSetup\s*:/, label: "globalSetup" },
  { re: /\bglobalTeardown\s*:/, label: "globalTeardown" },
  { re: /\bstorageState\s*:/, label: "storageState (saved sign-in)" },
];

export function findUnsupported(source: string): string[] {
  const live = stripComments(source);
  return UNSUPPORTED_FEATURES.filter((f) => f.re.test(live)).map((f) => f.label);
}

/**
 * Read the config governing an imported spec. Returns null when there is none,
 * or when it cannot be read — a missing config is an ordinary outcome here,
 * not an error, so nothing throws.
 */
export function readProjectConfig(specDir: string, scanRoot: string): ImportedProjectConfig | null {
  const configPath = findProjectConfig(specDir, scanRoot);
  if (!configPath) return null;
  let source: string;
  try {
    source = fs.readFileSync(configPath, "utf-8");
  } catch {
    return null;
  }
  const baseUrl = extractBaseUrl(source);
  const timeoutMs = extractTestTimeoutMs(source);
  return {
    configPath,
    ...(baseUrl ? { baseUrl } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    unsupported: findUnsupported(source),
  };
}

/** True when a URL string stands on its own, without a base to resolve against. */
export function isAbsoluteUrl(value: string): boolean {
  // A protocol-relative `//host/path` needs only a scheme, which the browser
  // supplies — it is not waiting on a baseURL.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("//");
}

/**
 * Every navigation target a spec names, in source order.
 *
 * ONE definition of what counts as a navigation, because two callers ask
 * different questions of it — "is there a relative one?" and "what does this
 * test point AT?" — and answers that disagree would put a base-URL warning on a
 * test whose URL column says it needs none.
 *
 * Matches any `goto`-ish call rather than `page.goto(` alone, which is the
 * whole point: a real suite wraps navigation in its own helper
 * (`gotoWithRetry(page, "/")`), so the narrower pattern finds nothing and
 * reports a suite of entirely relative navigations as having none.
 *
 * The literal has to LOOK like a location — a scheme, or a leading `/` — so
 * that `page.goto(url, { waitUntil: "domcontentloaded" })` yields the variable
 * it can't see rather than confidently returning "domcontentloaded".
 */
export function navigationTargets(source: string): string[] {
  const constants = stringConstants(source);
  const out: string[] = [];
  for (const call of source.matchAll(/\bgoto\w*\s*\(([^)]*)\)/gi)) {
    for (const arg of splitArguments(call[1]).slice(0, MAX_TARGET_ARG_POSITION)) {
      const value = literalValue(arg, constants);
      if (value === null) continue;
      out.push(value);
      break; // the first bare string argument of this call is the destination
    }
  }
  return out;
}

/** `const NAME = "…"` declarations, so a destination held in one can be read.
 *
 *  Not a nicety: two of the five specs this was first run against navigate to
 *  `gotoWithRetry(page, PRODUCT_PATH)`, with the path declared at the top of
 *  the file. A literals-only reader calls those tests "navigates nowhere", so
 *  they get no import warning and no run refusal — and then fail exactly the
 *  way this module exists to prevent. Same file only; a constant imported from
 *  elsewhere stays unresolved, which is the honest answer rather than a guess.
 *
 *  `\s*` around the `=` spans a line break, because a long path is routinely
 *  wrapped onto the next line by a formatter. */
function stringConstants(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`\n]*)\2/g,
  )) {
    if (!out.has(m[1])) out.set(m[1], m[3]);
  }
  return out;
}

/** One argument's value, if it can be known: a bare string literal, or an
 *  identifier bound to one. Null when it is anything else — an expression, an
 *  object, a template with a hole in it. */
function literalValue(arg: string, constants: Map<string, string>): string | null {
  const trimmed = arg.trim();
  const lit = trimmed.match(/^(['"`])([^'"`\n]*)\1$/);
  const raw = lit
    ? lit[2]
    : /^[A-Za-z_$][\w$]*$/.test(trimmed)
      ? constants.get(trimmed)
      : undefined;
  if (raw === undefined) return null;
  const value = raw.trim();
  if (!value || value.includes("${")) return null; // computed — don't guess
  return value;
}

/** How many leading arguments can hold the destination: `page.goto(url)` puts
 *  it first, a project's own wrapper (`gotoWithRetry(page, url)`) second. */
const MAX_TARGET_ARG_POSITION = 2;

/**
 * Split an argument list on its top-level commas.
 *
 * This is what tells a destination from an option. The first version of this
 * took any string literal inside the call, which reads
 * `page.goto(url, { waitUntil: "domcontentloaded" })` as a navigation to
 * "domcontentloaded" — so it was narrowed to literals that LOOKED like
 * locations, i.e. carried a scheme or a leading `/`. That traded one silent
 * wrong answer for another: `page.goto("dashboard")`, `page.goto("./cart")` and
 * `page.goto("?tab=orders")` are all perfectly ordinary relative navigations
 * that then registered as no navigation at all — no import warning, no run
 * refusal, and the protocol error this whole module exists to prevent.
 *
 * Position and nesting answer it properly: an option string is inside an object
 * literal, and a destination is an argument in its own right.
 */
function splitArguments(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote) {
      if (ch === "\\") i++; // skip the escaped character
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(args.slice(start, i));
      start = i + 1;
    }
  }
  out.push(args.slice(start));
  return out;
}

/** True when a spec navigates somewhere that only resolves against a baseURL. */
export function usesRelativeNavigation(source: string): boolean {
  return navigationTargets(source).some((t) => !isAbsoluteUrl(t));
}

/** Extensions worth reading when asking a whole imported test whether it needs
 *  a base URL. Matches what the import is willing to copy as a sibling. */
const SOURCE_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"]);
const MAX_TREE_FILES = 200;
const MAX_TREE_DEPTH = 8;

/**
 * Does this imported test navigate anywhere that needs a base URL?
 *
 * Asks the test's WHOLE sandbox, not just the spec, because the suite this was
 * written against keeps every navigation in a helper — `helpers.js` holds the
 * `page.goto`, and the spec only ever calls `gotoWithRetry(page, "/cart")`. A
 * spec-only answer is right for that file and wrong about the test.
 *
 * Bounded on files and depth: it runs before a run the user is waiting on, and
 * an imported project can be any shape.
 */
export function treeNeedsBaseUrl(specPath: string, sandboxDir?: string): boolean {
  const files = new Set<string>([specPath]);
  if (sandboxDir) {
    for (const f of sourceFilesUnder(sandboxDir)) files.add(f);
  }
  for (const file of files) {
    let source: string;
    try {
      source = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (usesRelativeNavigation(source)) return true;
  }
  return false;
}

/**
 * Should this run be refused for want of a base URL?
 *
 * All three clauses matter. Only an IMPORTED test can be in this state
 * (`sourceDir`), one that already has a base URL is fine, and a test whose
 * navigations are all absolute never needed one — refusing that last case would
 * block a working test over a field it has no use for.
 */
export function shouldRefuseForMissingBaseUrl(
  rec: { baseUrl?: string; sourceDir?: string; scriptPath: string },
  sandboxDir: string,
): boolean {
  if (rec.baseUrl) return false;
  if (!rec.sourceDir) return false;
  return treeNeedsBaseUrl(rec.scriptPath, sandboxDir);
}

function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > MAX_TREE_DEPTH || out.length >= MAX_TREE_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_TREE_FILES) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && SOURCE_EXT.has(path.extname(e.name))) out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

/** Where a spec first goes, as an absolute URL, or "" when that can't be known.
 *  A relative target resolves against `baseUrl`; without one there is no honest
 *  answer, and a stored `"/"` is worse than an empty column — it looks like a
 *  URL to everything downstream that treats the field as one. */
export function firstNavigationUrl(source: string, baseUrl?: string): string {
  for (const target of navigationTargets(source)) {
    if (isAbsoluteUrl(target)) {
      const abs = normalizeBaseUrl(target);
      if (abs) return abs;
      continue;
    }
    if (!baseUrl) continue;
    try {
      return new URL(target, baseUrl).href;
    } catch {
      /* fall through to the next target */
    }
  }
  return baseUrl ?? "";
}
