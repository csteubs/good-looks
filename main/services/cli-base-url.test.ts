// `--base-url` — the per-run override (R5), and the gate it goes through.
//
// Here rather than beside `cli/args.mjs` for the reason CLAUDE.md records:
// vitest's node project takes `main/**`, `mcp/**` and `renderer/lib/**`, so a
// test file under `cli/` matches NEITHER project and is silently never run.

import { describe, expect, it } from "vitest";

import { parseRunArgs } from "../../cli/args.mjs";
import type { RunOptions } from "../../cli/args.d.mts";
import { normalizeBaseUrl } from "../../shared/base-url.mjs";

describe("the flag goes through the same gate every other path uses", () => {
  it("keeps the NORMALIZED value, not what was typed", () => {
    // `HTTPS://Shop.EXAMPLE.com` and `https://shop.example.com/` are one base
    // URL. Storing the typed spelling would record two runs against the same
    // environment as two different ones, which is the misleading history this
    // field is recorded to prevent.
    expect(parseRunArgs(["--all", "--base-url", "HTTPS://Shop.EXAMPLE.com"])).toMatchObject({
      ok: true,
      options: { baseUrl: "https://shop.example.com/" },
    });
  });

  it("refuses a bare host, rather than guessing a scheme", () => {
    expect(parseRunArgs(["--all", "--base-url", "shop.example.com"])).toEqual({
      ok: false,
      error: '--base-url must be an http(s) URL, got "shop.example.com".',
    });
  });

  it("refuses a scheme a run has no business following", () => {
    // `file://` would point a run at the local disk, and `app://` is this
    // application's own scheme.
    for (const bad of ["file:///etc/passwd", "app://index.html", "ftp://files.test/"]) {
      expect(parseRunArgs(["--all", "--base-url", bad]).ok).toBe(false);
    }
  });

  it("refuses an un-interpolated variable reference", () => {
    // Otherwise `${PREVIEW_HOST}` is resolved as a literal hostname, and the
    // run quietly goes somewhere that is not a deployment at all.
    expect(parseRunArgs(["--all", "--base-url", "https://${PREVIEW_HOST}/"]).ok).toBe(false);
  });

  it("refuses the flag with no value, like every other value flag", () => {
    expect(parseRunArgs(["--all", "--base-url"])).toEqual({
      ok: false,
      error: "--base-url needs a value.",
    });
    // A following flag standing in for the value is the same mistake: this
    // would otherwise point the run at a host called "--json".
    expect(parseRunArgs(["--all", "--base-url", "--json"]).ok).toBe(false);
  });

  it("is absent when not given, so the test's own record decides", () => {
    // Narrowed by assertion rather than by an `if`: a guarded assertion passes
    // vacuously the day the parse starts failing, which is the shape CLAUDE.md
    // warns about.
    const parsed = parseRunArgs(["--all"]);
    expect(parsed.ok).toBe(true);
    expect((parsed as { ok: true; options: RunOptions }).options.baseUrl).toBeUndefined();
  });
});

describe("the gate itself", () => {
  // The parser's refusals are only as good as this, and this is now shared with
  // the app — an imported project's config and the app's own field come through
  // the same function. Covered directly so a change here cannot pass by being
  // untested on one side.
  it("returns the parsed href, so one URL has one spelling", () => {
    expect(normalizeBaseUrl("   https://trim.test   ")).toBe("https://trim.test/");
    expect(normalizeBaseUrl("http://localhost:3000")).toBe("http://localhost:3000/");
  });

  it("keeps a path, which a base URL may legitimately have", () => {
    expect(normalizeBaseUrl("https://shop.test/uk")).toBe("https://shop.test/uk");
  });

  it("answers null rather than throwing on anything unusable", () => {
    for (const bad of [null, undefined, 1234, {}, "", "   ", "not a url"]) {
      expect(normalizeBaseUrl(bad)).toBeNull();
    }
  });
});

describe("--var: what actually re-points a RECORDED test", () => {
  // The base-URL override moves imported suites and nothing else — measured
  // against real Playwright and recorded in DECISIONS 2026-08-22. A recorded
  // `goto` is the absolute URL the recorder watched, so `use.baseURL` is read
  // by nothing. `${name}` interpolation is what moves one, and this is how a
  // value reaches an unattended run: before it, the only source was a dataset
  // row, so the remedy the app offers was unreachable from CI.
  it("collects repeated name=value pairs", () => {
    expect(
      parseRunArgs(["--all", "--var", "site=https://pr-42.test", "--var", "user=alice"]),
    ).toMatchObject({
      ok: true,
      options: { vars: { site: "https://pr-42.test", user: "alice" } },
    });
  });

  it("splits on the FIRST = only, so a value may contain one", () => {
    // A URL with a query string is the obvious case, and splitting on every `=`
    // truncates it silently — the run then goes somewhere that looks right.
    expect(
      parseRunArgs(["--all", "--var", "u=https://x.test/?a=1&b=2"]),
    ).toMatchObject({ ok: true, options: { vars: { u: "https://x.test/?a=1&b=2" } } });
  });

  it("refuses a pair with no value and a name that is empty", () => {
    expect(parseRunArgs(["--all", "--var", "site"])).toEqual({
      ok: false,
      error: '--var needs name=value, got "site".',
    });
    expect(parseRunArgs(["--all", "--var", "=v"])).toEqual({
      ok: false,
      error: '--var needs name=value, got "=v".',
    });
  });

  it("allows an empty VALUE, which is a legitimate thing to set", () => {
    expect(parseRunArgs(["--all", "--var", "flag="])).toMatchObject({
      ok: true,
      options: { vars: { flag: "" } },
    });
  });

  it("is absent when not given, so a dataset row decides alone", () => {
    const parsed = parseRunArgs(["--all"]);
    expect(parsed.ok).toBe(true);
    expect((parsed as { ok: true; options: RunOptions }).options.vars).toBeUndefined();
  });
});
