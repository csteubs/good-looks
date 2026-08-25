/** One file written beside a spec before it runs. */
export interface RunFixture {
  file: string;
  source: string;
}

/** The capture fixture's filename — the spec redirect interpolates it. */
export declare const CAPTURE_FIXTURE_FILE: string;

/** The step reporter's filename, as the Playwright CLI is told to load it. */
export declare const STEP_REPORTER_FILE: string;

/** Written for EVERY run. The spec runtime is here because a generated spec
 *  IMPORTS it — absent, the spec does not load at all. */
export declare const ALWAYS_WRITTEN: readonly RunFixture[];

/** Written together when any capability needs them: the capture fixture imports
 *  the others, so writing one without the rest is an import error rather than a
 *  disabled feature. */
export declare const CAPABILITY_FIXTURES: readonly RunFixture[];

/** One capability, and whether an unattended (MCP/CLI) run turns it on. */
export interface CiFixturePolicy {
  capability: string;
  /** `true`/`false`, or a phrase naming the condition. */
  onInCi: boolean | string;
  why: string;
}

/** What an unattended run gets, decided per capability and in writing (R8). */
export declare const CI_FIXTURE_POLICY: readonly CiFixturePolicy[];

/** Redirect a spec's `@playwright/test` import onto the capture fixture,
 *  preserving line numbers. Null when there is nothing to redirect. */
export declare function redirectToCaptureFixture(source: string): string | null;
