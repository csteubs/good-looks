// Tests for what an import says out loud — and, as much, for when it says
// nothing.
//
// The empty case is load-bearing: `importWarnings` returning [] is what makes
// an ordinary import finish with one quiet "N tests imported", so a warning
// that fires on a suite that needs nothing turns every import into a stack of
// toasts nobody reads. The opposite failure is worse and is the reason this
// exists: a missing base URL surfaces at run time as a Playwright protocol
// error naming neither the config nor the URL, so if the warning is silent —
// or names the problem without naming the fix — the user learns nothing from a
// failed run.
//
// These assertions are about PHRASING, which is unusual for a unit test and
// deliberate here: "1 tests navigate to relative URLs ()" is not a crash, it is
// the whole product surface of this module.

import { describe, expect, it } from "vitest";

import type { ImportResult } from "./api";
import { importWarnings } from "./import-warnings";

type Subject = Parameters<typeof importWarnings>[0];

function result(over: Partial<Subject> = {}): Subject {
  return { needsBaseUrl: [], unsupported: [], ...over };
}

/** Distinctive enough that a `not.toContain` on one cannot be satisfied by the
 *  boilerplate around it. */
const NAMES = ["alpha", "bravo", "charlie", "delta", "echo"];

describe("importWarnings", () => {
  it("says nothing when the import brought in everything it needed", () => {
    expect(importWarnings(result())).toEqual([]);
  });

  describe("tests that need a base URL", () => {
    it("names the one test, in the singular", () => {
      const [warning, ...rest] = importWarnings(result({ needsBaseUrl: ["Checkout flow"] }));
      expect(rest).toEqual([]);
      expect(warning).toContain("Checkout flow navigates to relative URLs");
      // The plural branch would render this as "1 tests navigate…".
      expect(warning).not.toContain("1 test");
      expect(warning).not.toContain("tests navigate");
    });

    it("leads with the count, then the names, once there is more than one", () => {
      const [warning] = importWarnings(result({ needsBaseUrl: ["alpha", "bravo"] }));
      expect(warning).toContain("2 tests navigate to relative URLs (alpha, bravo)");
    });

    it("names three without summarising — three is the cap, not past it", () => {
      const [warning] = importWarnings(result({ needsBaseUrl: NAMES.slice(0, 3) }));
      expect(warning).toContain("3 tests navigate to relative URLs (alpha, bravo, charlie)");
      expect(warning).not.toContain("more");
    });

    it("summarises the fourth rather than listing it", () => {
      const [warning] = importWarnings(result({ needsBaseUrl: NAMES.slice(0, 4) }));
      // The comma before "and" is deliberate: without it the tail reads as a
      // third test called "charlie and 1 more".
      expect(warning).toContain(
        "4 tests navigate to relative URLs (alpha, bravo, charlie, and 1 more)",
      );
      expect(warning).not.toContain("delta");
    });

    it("keeps the true count outside the truncated list, so nothing is understated", () => {
      // A folder import can bring in hundreds. The list is capped; the count
      // reported to the user must not be.
      const [warning] = importWarnings(result({ needsBaseUrl: NAMES }));
      expect(warning).toContain("5 tests navigate to relative URLs");
      expect(warning).toContain("(alpha, bravo, charlie, and 2 more)");
      expect(warning).not.toContain("delta");
      expect(warning).not.toContain("echo");
    });

    it("says what is missing and where to put it, without inventing a file", () => {
      // Naming only the symptom sends the user back to the same failed run.
      // But this fires when the project had NO config at all as well, so it
      // must not send them looking for a playwright.config that isn't there.
      const [warning] = importWarnings(result({ needsBaseUrl: ["alpha"] }));
      expect(warning).toContain("no base URL came with the imported project");
      expect(warning).not.toContain("playwright.config");
      expect(warning).toContain("Set Base URL on the test before running it.");
    });
  });

  describe("config features this app does not reproduce", () => {
    it("names the single feature found", () => {
      const [warning, ...rest] = importWarnings(result({ unsupported: ["webServer"] }));
      expect(rest).toEqual([]);
      expect(warning).toContain("playwright.config uses webServer");
      expect(warning).toContain("does not run");
    });

    it("lists every feature found, in the order it was given", () => {
      const [warning] = importWarnings(
        result({ unsupported: ["webServer", "globalSetup", "globalTeardown", "storageState"] }),
      );
      // Unsupported features are a closed, short set — unlike test names, they
      // are never summarised away, because "and 1 more" would hide the one the
      // user's suite actually depends on.
      expect(warning).toContain("webServer, globalSetup, globalTeardown, storageState");
      expect(warning).not.toContain("more");
    });
  });

  it("reports both, base URL first — it is the one that stops the very next run", () => {
    const out = importWarnings(result({ needsBaseUrl: ["alpha"], unsupported: ["webServer"] }));
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("alpha");
    expect(out[0]).toContain("relative URLs");
    expect(out[1]).toContain("webServer");
  });

  describe("a result from an older backend, missing the fields entirely", () => {
    it("does not throw, and warns about nothing", () => {
      expect(importWarnings({} as unknown as Subject)).toEqual([]);
    });

    it("still warns about the half that is present", () => {
      expect(
        importWarnings({ needsBaseUrl: ["alpha"] } as unknown as Subject),
      ).toHaveLength(1);
      expect(
        importWarnings({ unsupported: ["storageState"] } as unknown as Subject),
      ).toHaveLength(1);
    });

    it("treats an explicit undefined the same as an absent key", () => {
      expect(
        importWarnings({ needsBaseUrl: undefined, unsupported: undefined } as unknown as Subject),
      ).toEqual([]);
    });
  });

  it("reads only the fields it declares, so a whole ImportResult works unchanged", () => {
    const full: ImportResult = {
      imported: 2,
      names: ["Login", "Checkout"],
      ids: ["t1", "t2"],
      needsBaseUrl: [],
      unsupported: [],
    };
    expect(importWarnings(full)).toEqual([]);
  });
});
