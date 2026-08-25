// The fixture's axe check, driven as the SHIPPED STRING.
//
// This is the DOM_HELPERS / LOG_CAPTURE_HELPERS idiom again: the capture fixture
// is a raw JS string written next to the specs, so a test that re-implemented
// `runAxe` would verify something that never runs. Here the function is pulled
// out of `captureFixtureSource` itself and executed.
//
// WHAT IT GUARDS. `page.evaluate` SERIALIZES its callback and re-evaluates it in
// the page, which keeps no scope from the fixture module. A callback that named
// the fixture's `MAX_VIOLATIONS` therefore threw `ReferenceError` inside the
// page — and it threw AFTER axe had finished, so every check paid full price,
// was swallowed by the "never fail the test" catch, and returned null. The
// manifest got no `a11y` entry, the replay had nothing to enrich, and the whole
// feature reported nothing while the toggle sat there switched on. Nothing else
// in the suite can see this: the pipeline checks seed manifest entries directly,
// and the fixture is excluded from coverage.
//
// So the fake `page` below deliberately re-evaluates the callback from its
// source, exactly as Playwright does. Running it in the same scope — the
// obvious way to write this test — would pass against the bug.

/* global window */

import { describe, expect, it, vi } from "vitest";

import { captureFixtureSource } from "../../shared/capture-fixture-source.mjs";

/** Pull one top-level function out of the fixture source by name. Top-level
 *  declarations there close with a `}` in column 0, which is what bounds it. */
function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  expect(start, `${name} not found in the fixture source`).toBeGreaterThan(-1);
  const end = src.indexOf("\n}\n", start);
  expect(end, `${name} has no top-level close`).toBeGreaterThan(start);
  return src.slice(start, end + 2);
}

/** Read a numeric const out of the fixture source, so the caps asserted here are
 *  the ones that ship rather than a copy that can drift. */
function constant(src: string, name: string): number {
  const m = new RegExp(`const ${name} = (\\d+);`).exec(src);
  expect(m, `${name} not found in the fixture source`).not.toBeNull();
  return Number(m![1]);
}

const MAX_VIOLATIONS = constant(captureFixtureSource, "MAX_VIOLATIONS");
const MAX_NODES = constant(captureFixtureSource, "MAX_NODES");

type RunAxe = (page: unknown) => Promise<unknown[] | null>;

/** Compile the shipped `runAxe` with the fixture's module scope around it. */
function loadRunAxe(): RunAxe {
  const body = `${extractFunction(captureFixtureSource, "runAxe")}\nreturn runAxe;`;
  return new Function("MAX_VIOLATIONS", "MAX_NODES", body)(MAX_VIOLATIONS, MAX_NODES) as RunAxe;
}

/** A `page` whose `evaluate` loses the caller's scope, like the real one. */
function fakePage() {
  return {
    isClosed: () => false,
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => {
      const isolated = new Function(`return (${fn.toString()})`)() as (a: unknown) => unknown;
      return await isolated(arg);
    },
  };
}

function installAxe(violationCount: number, nodeCount: number) {
  const violations = Array.from({ length: violationCount }, (_, i) => ({
    id: `rule-${i}`,
    impact: "serious",
    help: `help for rule ${i}`,
    nodes: Array.from({ length: nodeCount }, (_, j) => ({ target: [`.n${i}-${j}`] })),
  }));
  (window as unknown as { axe?: unknown }).axe = { run: async () => ({ violations }) };
  return () => {
    delete (window as unknown as { axe?: unknown }).axe;
  };
}

describe("the capture fixture's axe check", () => {
  it("returns compacted violations instead of throwing inside the page", async () => {
    const uninstall = installAxe(3, 2);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const result = await loadRunAxe()(fakePage());
      // Not null: null is what the swallowed ReferenceError produced, and it is
      // indistinguishable from "the page had no axe" everywhere downstream.
      expect(result).not.toBeNull();
      expect(result).toHaveLength(3);
      expect(result![0]).toEqual({
        id: "rule-0",
        impact: "serious",
        help: "help for rule 0",
        nodes: [".n0-0", ".n0-1"],
      });
      // The catch writes to stderr and returns null. A silent run is the proof
      // that nothing was swallowed.
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      uninstall();
    }
  });

  it("applies the fixture's own caps to violations and nodes", async () => {
    const uninstall = installAxe(MAX_VIOLATIONS + 5, MAX_NODES + 5);
    try {
      const result = await loadRunAxe()(fakePage());
      expect(result).toHaveLength(MAX_VIOLATIONS);
      expect((result![0] as { nodes: string[] }).nodes).toHaveLength(MAX_NODES);
    } finally {
      uninstall();
    }
  });

  it("reports null when axe never got injected", async () => {
    delete (window as unknown as { axe?: unknown }).axe;
    expect(await loadRunAxe()(fakePage())).toBeNull();
  });
});
