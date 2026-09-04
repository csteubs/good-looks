// `--junit` — what the CLI's report says, and what it must never contain.
//
// It lives here rather than beside `cli/junit.mjs` for the reason CLAUDE.md
// records: vitest's node project takes `main/**`, `mcp/**` and
// `renderer/lib/**`, so a test file under `cli/` matches NEITHER project and is
// silently never run. `cli-exit.test.ts` is here for the same reason.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { junitReportFor, writeJunitReport } from "../../cli/junit.mjs";
import { ambientCiSecretValues } from "../../shared/ci-secrets.mjs";

const tmp = mkdtempSync(join(tmpdir(), "gl-junit-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const passed = { testId: "t-a", testName: "signs in", status: "passed" as const, durationMs: 1200 };

describe("a skipped test is not a passing one", () => {
  // The failure this branch exists to prevent. `junitXml` emitted a bare
  // `<testcase/>` for anything that was not "failed", and every CI reads that
  // as a pass — so a test the CLI DECLINED to run for want of a credential
  // arrived in a dashboard green. No RunRecord can be skipped, so nothing on
  // the app's side could reach it; the CLI builds from a run RESULT, which
  // carries the third state.
  const skipped = {
    testId: "t-b",
    testName: "checks out",
    status: "skipped" as const,
    durationMs: 0,
    note: "declares 1 secret variable with no value here: PASSWORD.",
  };

  it("emits <skipped/> and counts it in the suite", () => {
    const xml = junitReportFor([passed, skipped]);
    expect(xml).toContain('tests="2"');
    expect(xml).toContain('skipped="1"');
    expect(xml).toContain('failures="0"');
    expect(xml).toContain("<skipped");
  });

  it("carries the reason, so the row says what to do about it", () => {
    expect(junitReportFor([skipped])).toContain("PASSWORD");
  });

  it("collapses the reason to one line", () => {
    // An XML attribute may legally hold a newline and a conformant parser turns
    // it into a space — so a multi-line note renders differently depending on
    // whose parser the CI uses, and this note is the whole content of the row.
    const multiline = { ...skipped, note: "first line\nsecond line\n  third" };
    const attr = junitReportFor([multiline]).match(/<skipped message="([^"]*)"/)![1];
    expect(attr).toBe("first line second line third");
  });

  it("does not emit a skipped element for a run that passed", () => {
    const xml = junitReportFor([passed]);
    expect(xml).not.toContain("<skipped");
    expect(xml).toContain('skipped="0"');
  });
});

describe("the failing step reaches the report", () => {
  it("says which step, not just the exit code", () => {
    const xml = junitReportFor([
      {
        testId: "t-c",
        testName: "pays",
        status: "failed" as const,
        exitCode: 1,
        durationMs: 4000,
        failedStepIndex: 6,
        stepCount: 12,
      },
    ]);
    // 1-based in the sentence, because it is read by a person counting a list.
    expect(xml).toContain("Failed at step 7 of 12");
  });

  it("falls back to the exit code when no step was recorded", () => {
    const xml = junitReportFor([
      { testId: "t-d", testName: "pays", status: "failed", exitCode: 1, durationMs: 10 },
    ]);
    expect(xml).toContain("exit 1");
    expect(xml).not.toContain("Failed at step");
  });
});

describe("redaction", () => {
  it("removes a resolved secret value from the report", () => {
    const xml = junitReportFor([{ ...passed, testName: "signs in as hunter2" }], {
      secretValues: ["hunter2"],
    });
    expect(xml).not.toContain("hunter2");
    expect(xml).toContain("[redacted]");
  });

  it("strips the mailbox token, which no test declares and the environment supplies", () => {
    // The gap this closes, stated narrowly because the narrow version is the
    // true one. `resolveCiSecrets` answers "what did this test ask for", and
    // the mailbox token is asked for by nothing: the `emailCode` step reads
    // `GLAZE_MAILBOX_TOKEN` from the environment itself. So on a runner it is
    // present, is sent as a bearer, and is named by no `test.variables` entry
    // — outside the budget R7 says must cover whatever supplies a run.
    //
    // What it is NOT is a hole in `<failure>` text. `junitReportFor` names its
    // eight fields explicitly rather than spreading, exactly so a field added
    // later cannot leak, and a Playwright error is not among them: a failure
    // reduces to "Failed at step N of M · exit 1". `note` is the one free-text
    // field that survives, set from `String(err)` when the RUNNER throws, and
    // it is what this test drives.
    const TOKEN = "GLMAILBOXTOKEN-not-real-0123456789";
    const failure = {
      ...passed,
      status: "skipped" as const,
      testName: "signs in with a code",
      note: `Error: could not start the run with authorization: Bearer ${TOKEN}`,
    };

    // Not vacuous: the token really is in the text the report is built from,
    // and the resolver really does hand it over when the environment has it.
    expect(junitReportFor([failure])).toContain(TOKEN);
    expect(ambientCiSecretValues({ GLAZE_MAILBOX_TOKEN: TOKEN })).toEqual([TOKEN]);

    const xml = junitReportFor([failure], {
      secretValues: ambientCiSecretValues({ GLAZE_MAILBOX_TOKEN: TOKEN }),
    });
    expect(xml).not.toContain(TOKEN);
    expect(xml).toContain("[redacted]");
    // …and the reason is still legible, which is the point of redacting rather
    // than dropping the message.
    expect(xml).toContain("could not start the run");
  });

  it("keeps the mailbox ENDPOINT, which is not a credential", () => {
    // A run that cannot say which host it polled is a run nobody can debug —
    // the same rule `main/services/secret-redaction.ts` states for the app.
    const URL = "https://mailbox.example.workers.dev/messages";
    expect(
      ambientCiSecretValues({ GLAZE_MAILBOX_URL: URL, GLAZE_MAILBOX_TOKEN: "tok-0123456789" }),
    ).toEqual(["tok-0123456789"]);
    const xml = junitReportFor([{ ...passed, testName: `polled ${URL}` }], {
      secretValues: ambientCiSecretValues({ GLAZE_MAILBOX_URL: URL, GLAZE_MAILBOX_TOKEN: "tok-0123456789" }),
    });
    expect(xml).toContain("mailbox.example.workers.dev");
  });

  it("contributes nothing when the environment has no mailbox token", () => {
    // The empty and absent cases both mean "no credential here", and an empty
    // string in the list is what `redact` would otherwise have to defend
    // against — it is filtered at the source instead.
    expect(ambientCiSecretValues({})).toEqual([]);
    expect(ambientCiSecretValues({ GLAZE_MAILBOX_TOKEN: "" })).toEqual([]);
    expect(ambientCiSecretValues()).toEqual([]);
  });

  it("survives a non-string in the value list instead of throwing the report away", () => {
    // `redact` filters on `s.length`, so an `undefined` in the list throws
    // `Cannot read properties of undefined` — from inside the writer, AFTER the
    // run has finished. The operator would see a passing suite and a stack
    // trace where the report should be, and the cause would be a variable
    // record with no value rather than anything about the run. Filtered at this
    // boundary, because this is the boundary that assembles the list.
    const xml = junitReportFor([passed], {
      secretValues: [undefined as unknown as string, null as unknown as string, ""],
    });
    expect(xml).toContain("signs in");
    expect(xml).not.toContain("[redacted]");
  });

  it("still redacts the real values in a list that also holds a bad one", () => {
    // The half that matters: filtering must not be an early return that skips
    // redaction entirely.
    const xml = junitReportFor([{ ...passed, testName: "signs in as hunter2" }], {
      secretValues: [undefined as unknown as string, "hunter2"],
    });
    expect(xml).not.toContain("hunter2");
    expect(xml).toContain("[redacted]");
  });
});

describe("what the report is built from", () => {
  it("emits no URL and no variable values, whatever the result carries", () => {
    // What this actually proves is about the OUTPUT, and it is worth pinning on
    // its own: a result carries `vars` — a dataset row's VALUES — on some paths,
    // and an internal URL on all of them, and this file leaves the machine by
    // definition.
    //
    // It does NOT prove the builder names its fields rather than spreading the
    // result: `junitXml` reads a fixed set, so a spread passes this too. That
    // property is a fact about the source and is pinned where it is checkable,
    // in `check:emit-redaction`. Said here because a test whose comment claims
    // more than it checks is worse than no comment.
    const xml = junitReportFor([
      {
        ...passed,
        vars: { CARD_NUMBER: "4242424242424242" },
        note: undefined,
        url: "https://internal.example/checkout",
      } as unknown as Record<string, unknown>,
    ]);
    expect(xml).not.toContain("4242424242424242");
    expect(xml).not.toContain("internal.example");
  });

  it("reports an empty invocation as an empty suite, not as a pass", () => {
    const xml = junitReportFor([]);
    expect(xml).toContain('tests="0"');
    expect(xml).toContain('failures="0"');
  });
});

describe("writing it", () => {
  it("resolves a relative path against the cwd and reports what it wrote", () => {
    const dest = join(tmp, "results.xml");
    const written = writeJunitReport(dest, [passed]);
    expect(written.path).toBe(dest);
    expect(written.count).toBe(1);
    expect(written.bytes).toBeGreaterThan(0);
    expect(readFileSync(dest, "utf-8")).toContain("signs in");
  });

  it("throws a sentence naming the path when it cannot write", () => {
    // A directory that does not exist, which is the commonest form of this on a
    // CI runner — an artifacts folder the job never created.
    expect(() => writeJunitReport(join(tmp, "nope", "results.xml"), [passed])).toThrow(
      /Could not write .*nope/,
    );
  });
});
