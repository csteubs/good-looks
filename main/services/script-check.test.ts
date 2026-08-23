// The pure half of the pre-save script check: reading the reporter's file,
// naming the draft, and the spawn lifecycle around a fake CLI. The real CLI is
// driven by `check:script-check` and by `tests:checkScript` in handlers.test.ts.

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  draftPathFor,
  fileFilterFor,
  parseListReport,
  runListCheck,
  type ListCheckOptions,
} from "./script-check.js";

const DRAFT = "/data/scripts/t-login.draft-77-3.spec.ts";

const BABEL_MESSAGE =
  "SyntaxError: " +
  DRAFT +
  ': Unexpected token, expected "," (3:39)\n\n' +
  '  1 | import { test, expect } from "@playwright/test";\n' +
  '  2 | test("broken", async ({ page }) => {\n' +
  '> 3 |   await page.goto("https://example.com";\n' +
  "    |                                        ^\n" +
  "  4 | });\n";

describe("parseListReport", () => {
  it("reads a syntax error back with its line, drops the CLI's 'No tests found' echo, and never names the draft", () => {
    const raw = JSON.stringify({
      errors: [
        {
          message: BABEL_MESSAGE,
          location: { file: DRAFT, line: 3, column: 39 },
          snippet: "   at " + DRAFT + ":3\n\n> 3 |   await page.goto(",
        },
        { message: "Error: No tests found.\nMake sure that arguments are regular expressions matching test files." },
      ],
      tests: [],
    });
    const { errors, tests } = parseListReport(raw, DRAFT, "t-login.spec.ts");
    expect(tests).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('SyntaxError: Unexpected token, expected "," (3:39)');
    expect(errors[0].line).toBe(3);
    expect(errors[0].column).toBe(39);
    expect(errors[0].snippet).toContain("t-login.spec.ts:3");
    expect(JSON.stringify(errors)).not.toContain("draft-");
  });

  it("renames the draft however the CLI spelled its path — absolute, realpath'd, or relative", () => {
    // macOS keeps the temp dir behind a symlink, so the CLI reports
    // `/private/var/...` for a draft written to `/var/...`; and a duplicate-
    // title message spells the first declaration relative to the root dir.
    const draft = "/var/folders/ab/scripts/t-login.draft-77-3.spec.ts";
    const raw = JSON.stringify({
      errors: [
        {
          message:
            'Error: duplicate test title "a", first declared in ../../../../private/var/folders/ab/scripts/t-login.draft-77-3.spec.ts:2',
          location: { line: 3, column: 1 },
          snippet: "   at t-login.draft-77-3.spec.ts:3",
        },
      ],
    });
    const { errors } = parseListReport(raw, draft, "t-login.spec.ts");
    expect(errors[0].message).toBe('Error: duplicate test title "a", first declared in t-login.spec.ts:2');
    expect(errors[0].snippet).toBe("   at t-login.spec.ts:3");
  });

  it("strips the colour a CI terminal puts around the code frame", () => {
    // Reproduced under CI=true and FORCE_COLOR=1: the headline survived but
    // the snippet's `> 3 |` marker was wrapped in ANSI and never matched.
    const raw = JSON.stringify({
      errors: [
        {
          message: "\u001b[31mSyntaxError\u001b[39m: " + DRAFT + ': Unexpected token, expected "," (3:39)',
          location: { line: 3, column: 39 },
          snippet: "\u001b[0m \u001b[90m 2 |\u001b[39m test()\n\u001b[31m\u001b[1m>\u001b[22m\u001b[39m\u001b[90m 3 |\u001b[39m   await page.goto(",
        },
      ],
    });
    const { errors } = parseListReport(raw, DRAFT, "t-login.spec.ts");
    expect(errors[0].message).toBe('SyntaxError: Unexpected token, expected "," (3:39)');
    expect(errors[0].snippet).toContain("> 3 |");
    // eslint-disable-next-line no-control-regex
    expect(JSON.stringify(errors)).not.toMatch(/\u001b/);
  });

  it("keeps 'No tests found' when it is the only finding, in plainer words", () => {
    const raw = JSON.stringify({
      errors: [{ message: "Error: No tests found.\nMake sure that arguments are regular expressions." }],
      tests: [],
    });
    const { errors } = parseListReport(raw, DRAFT, "t-login.spec.ts");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/defines no tests/);
    expect(errors[0].line).toBeUndefined();
  });

  it("takes the code frame from the message when the CLI gave no snippet", () => {
    const raw = JSON.stringify({
      errors: [{ message: BABEL_MESSAGE, location: { line: 3, column: 39 } }],
    });
    const { errors } = parseListReport(raw, DRAFT, "t-login.spec.ts");
    expect(errors[0].snippet).toMatch(/^ {2}1 \| import/);
    expect(errors[0].snippet).not.toContain("SyntaxError");
  });

  it("reports the collected tests with their lines and drops malformed rows", () => {
    const raw = JSON.stringify({
      errors: [],
      tests: [
        { title: "ok", line: 2, column: 5 },
        { title: 7, line: 9 },
        { title: "no line" },
        { title: "bad line", line: -1 },
      ],
    });
    const { errors, tests } = parseListReport(raw, DRAFT, "t-login.spec.ts");
    expect(errors).toEqual([]);
    expect(tests).toEqual([{ title: "ok", line: 2 }]);
  });

  it("treats an unreadable report as a failed check, not a pass", () => {
    const { errors } = parseListReport("not json", DRAFT, "t-login.spec.ts");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/no readable report/);
  });

  it("ignores a column without a line, and a non-integer line", () => {
    const raw = JSON.stringify({
      errors: [
        { message: "Error: x", location: { column: 4 } },
        { message: "Error: y", location: { line: 2.5, column: 1 } },
      ],
    });
    const { errors } = parseListReport(raw, DRAFT, "t.spec.ts");
    expect(errors.map((e) => [e.line, e.column])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
    ]);
  });
});

describe("draftPathFor", () => {
  it("sits in the spec's own directory, so relative imports resolve as they will at run time", () => {
    const p = draftPathFor("/data/scripts/imported/t-9/tests/login.spec.ts", 1);
    expect(path.dirname(p)).toBe("/data/scripts/imported/t-9/tests");
  });

  it("still matches Playwright's default testMatch and still names the test", () => {
    const p = draftPathFor("/data/scripts/t-login.spec.ts", 4);
    expect(path.basename(p)).toMatch(/^t-login\.draft-\d+-4\.spec\.ts$/);
    // The default testMatch, as the CLI reports it: **/*.@(spec|test).?(c|m)[jt]s?(x)
    expect(path.basename(p)).toMatch(/\.(spec|test)\.[cm]?[jt]sx?$/);
  });

  it("strips a .test.mjs-style suffix rather than doubling it", () => {
    expect(path.basename(draftPathFor("/x/a.test.mjs", 0))).toMatch(/^a\.draft-\d+-0\.spec\.ts$/);
  });

  it("numbers successive drafts apart", () => {
    expect(draftPathFor("/x/a.spec.ts")).not.toBe(draftPathFor("/x/a.spec.ts"));
  });
});

describe("fileFilterFor", () => {
  it("escapes everything a regex would read as syntax", () => {
    const f = fileFilterFor("/a (1)/b+c/t.1.spec.ts");
    expect(new RegExp(f).test("/a (1)/b+c/t.1.spec.ts")).toBe(true);
    expect(new RegExp(f).test("/a (1)/b+c/tX1.spec.ts")).toBe(false);
  });
});

/** A stand-in for the CLI process: an emitter with the two streams and a
 *  `kill`. The test script decides what the "process" does. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
}

describe("runListCheck", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "script-check-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function opts(
    behave: (child: FakeChild, args: string[], env: NodeJS.ProcessEnv) => void,
    extra: Partial<ListCheckOptions> = {},
  ): ListCheckOptions {
    return {
      specPath: path.join(dir, "t-1.spec.ts"),
      source: 'import { test } from "@playwright/test";\ntest("a", async () => {});\n',
      cliPath: "/fake/cli.js",
      configPath: path.join(dir, "playwright.config.ts"),
      reporterPath: path.join(dir, "glaze-list-reporter.mjs"),
      cwd: dir,
      env: {},
      execPath: "/fake/node",
      spawnImpl: ((_cmd: string, args: string[], o: { env: NodeJS.ProcessEnv }) => {
        const child = new FakeChild();
        setTimeout(() => behave(child, args, o.env), 0);
        return child;
      }) as unknown as ListCheckOptions["spawnImpl"],
      ...extra,
    };
  }

  it("writes the draft beside the spec for the CLI, reads the report, and removes both", async () => {
    let seenDraft = "";
    let seenArgs: string[] = [];
    let seenEnv: NodeJS.ProcessEnv = {};
    let draftExistedDuringRun = false;
    const result = await runListCheck(
      opts((child, args, env) => {
        // args = [cliPath, "test", <escaped draft path>, "--list", ...]. The
        // draft must be on disk while the CLI runs and gone afterwards.
        // Recorded here, asserted below: a throw inside this callback would
        // surface as an unhandled error, not a failed assertion.
        seenArgs = args;
        seenEnv = env;
        seenDraft = args[2].replace(/\\(.)/g, "$1");
        draftExistedDuringRun = fs.existsSync(seenDraft);
        fs.writeFileSync(
          env.GLAZE_LIST_OUT as string,
          JSON.stringify({ errors: [], tests: [{ title: "a", line: 2, column: 1 }] }),
        );
        child.emit("close", 0);
      }),
    );
    expect(seenArgs[0]).toBe("/fake/cli.js");
    expect(seenArgs[1]).toBe("test");
    expect(seenArgs).toContain("--list");
    expect(seenArgs).toContain("--config");
    expect(seenEnv.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(draftExistedDuringRun).toBe(true);
    expect(path.dirname(seenDraft)).toBe(dir);
    expect(fs.existsSync(seenDraft)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.tests).toEqual([{ title: "a", line: 2 }]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("is a failure, with the CLI's last words, when the CLI dies before reporting", async () => {
    const result = await runListCheck(
      opts((child) => {
        child.stderr.emit("data", Buffer.from("Error: Cannot find module 'playwright'\n"));
        child.emit("close", 2);
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/code 2/);
    expect(result.errors[0].message).toMatch(/Cannot find module 'playwright'/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("is a failure when the process cannot start at all", async () => {
    const result = await runListCheck(
      opts((child) => {
        child.emit("error", new Error("spawn ENOENT"));
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/Couldn't start Playwright/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("kills and reports a CLI that never finishes", async () => {
    let child: FakeChild | null = null;
    const result = await runListCheck(
      opts(
        (c) => {
          child = c;
          // never closes
        },
        { timeoutMs: 30 },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/timed out/);
    expect((child as unknown as FakeChild).killed).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("does not read a clean report as a pass when the CLI exited non-zero", async () => {
    const result = await runListCheck(
      opts((child, _args, env) => {
        fs.writeFileSync(env.GLAZE_LIST_OUT as string, JSON.stringify({ errors: [], tests: [] }));
        child.emit("close", 1);
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/exited with code 1/);
  });
});
