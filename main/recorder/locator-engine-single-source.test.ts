// The locator engine is spelled once, and a process with no build step can load it.
//
// Two properties, and the second is the reason the first matters.
//
// ── One spelling ──────────────────────────────────────────────────────────
// `DOM_HELPERS` and friends are SOURCE TEXT evaluated by four different
// runtimes — an Electron isolated world, the replayer, a page evaluate, a
// Playwright worker's init script. Nothing type-checks them, nothing imports
// them as code, and a second copy would not fail: it would answer locator
// questions slightly differently in one runtime than another, which surfaces as
// "the trainer said this step was unique and the run says it matches nine".
// That is the same failure `shared/step-semantics.mjs` and
// `shared/overlay-rules.mjs` exist to prevent, and it is why the engine had to
// become one module rather than one module plus a re-export.
//
// ── Loadable by plain Node ────────────────────────────────────────────────
// This is what the move was FOR. Standing overlay rules and run-time Auto-Heal
// are both delivered to a run as source text built from these strings, and both
// were unavailable to an MCP or CLI run for one reason: the strings lived in
// compiled TypeScript. So the test does not read an import list and conclude the
// module is portable — it hands the file to a bare `node` with no loader, no
// alias table and no bundler, and asks. Reading source proves what the code
// says; booting it proves what a run gets. (`check:mcp-boot` and
// `check:cli-exit` are here for the same reason.)

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ENGINE = "shared/locator-engine.mjs";

/** The names the engine owns. A declaration of any of these anywhere else is a
 *  second engine, whatever it is called. */
const OWNED = [
  "DOM_HELPERS",
  "CONTEXT_HELPERS",
  "UNIQUENESS_HELPERS",
  "MAX_UNIQUENESS_SCAN",
  "MAX_SHADOW_ROOTS",
  "UNCAPPED_SCAN",
];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (name === "node_modules" || name === "build" || name === "dist") continue;
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) {
        walk(rel);
        continue;
      }
      if (/\.(ts|tsx|mjs|mts)$/.test(name)) out.push(rel);
    }
  };
  for (const dir of ["main", "renderer", "mcp", "cli", "shared", "e2e"]) walk(dir);
  return out;
}

describe("the locator engine is spelled once", () => {
  it("declares each of its names in exactly one file", () => {
    const declarations: Record<string, string[]> = {};
    for (const file of sourceFiles()) {
      const source = readFileSync(join(ROOT, file), "utf8");
      for (const name of OWNED) {
        // A DECLARATION, not a mention: an import names it too, and a comment
        // naming it is how the rest of the repo points at it.
        if (new RegExp(`^(export )?(const|let|var|function) ${name}\\b`, "m").test(source)) {
          (declarations[name] ??= []).push(file);
        }
      }
    }
    for (const name of OWNED) {
      expect(declarations[name] ?? [], `${name} is declared once`).toEqual([ENGINE]);
    }
  });

  it("is imported from shared/ by every consumer", () => {
    const engineAbs = join(ROOT, ENGINE);
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file === ENGINE) continue;
      const source = readFileSync(join(ROOT, file), "utf8");
      // Only files that actually IMPORT one of the names are consumers; the
      // many files that merely name one in a comment are not.
      const imports = [...source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"([^"]+)";/g)];
      for (const [, names, spec] of imports) {
        const list = names.split(",").map((n) => n.trim().split(/\s+as\s+/)[0]);
        if (!list.some((n) => OWNED.includes(n))) continue;
        // RESOLVED against the importing file, not pattern-matched on the text.
        // The first draft required the specifier to contain "shared/", which is
        // true of every consumer outside that directory and false of every one
        // inside it — so `shared/dismiss-fixture-source.mjs`, importing its
        // neighbour as `./locator-engine.mjs`, was reported as a second engine.
        // A specifier is a path, so compare it as one.
        const resolved = resolve(dirname(join(ROOT, file)), spec);
        if (resolved !== engineAbs) offenders.push(`${file} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("imports nothing outside shared/", () => {
    const source = readFileSync(join(ROOT, ENGINE), "utf8");
    const specs = [...source.matchAll(/from\s*"([^"]+)";/g)].map((m) => m[1]);
    // A relative specifier that does not stay in this directory, or a bare
    // package name, is a dependency the MCP cannot follow.
    expect(specs.filter((s) => !/^\.\/[a-z0-9-]+\.mjs$/.test(s))).toEqual([]);
  });
});

describe("a process with no build step can load it", () => {
  it("imports under a bare node, with no loader or alias table", () => {
    // The MCP server is plain .mjs run by whatever node the user has. If this
    // file needed a transform, every fixture built from it would be unavailable
    // there — which is exactly the state the extraction ended.
    const script = `import * as m from ${JSON.stringify(join(ROOT, ENGINE))};
      const missing = ${JSON.stringify(OWNED)}.filter((k) => !(k in m));
      if (missing.length) { console.error("missing: " + missing.join(",")); process.exit(1); }
      const bad = ${JSON.stringify(OWNED)}.filter((k) => {
        const v = m[k];
        return typeof v === "string" ? v.length === 0 : !(typeof v === "number" && v > 0);
      });
      if (bad.length) { console.error("empty: " + bad.join(",")); process.exit(1); }
      process.stdout.write("ok");`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });
    expect(out).toBe("ok");
  });
});
