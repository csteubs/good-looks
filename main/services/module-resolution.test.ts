// The `node_modules` symlink the generated specs resolve through.
//
// WHY THIS EXISTS. Every run failed at collection with "Playwright Test did not
// expect test() to be called here", then "No tests found" — no step executed,
// and nothing in Playwright's message mentions a symlink. The cause was here:
// `<scriptsDir>/node_modules` still pointed into the Glaze SDK's tree, because
// the port ADOPTS the legacy Glaze data directory (main/shell/user-data.ts) and
// that directory came with the old install's link inside it. The spec resolved
// a second copy of @playwright/test through the link while the CLI ran from
// ours, and Playwright compares module identity rather than version.
//
// The old code only ever created a MISSING link. Both of the cases below are
// ones it left broken, and neither raises anything a user would see:
//
//  - a link to a tree that still exists   → two Playwright copies, every run fails
//  - a link to a tree that has been deleted → `existsSync` follows symlinks and
//    answers false, so `symlinkSync` threw EEXIST, the warning was swallowed,
//    and resolution silently fell back to NODE_PATH — which ESM imports (the
//    capture fixture is `.mjs`) do not consult at all.
//
// Real directories and real symlinks throughout: the bug was about what is on
// disk, and a mocked fs would have agreed with whatever the code believed.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureModuleResolution } from "./playwright-runner.js";

let root: string;
let scriptsDir: string;
let ours: string;
let theirs: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-module-resolution-"));
  scriptsDir = path.join(root, "scripts");
  ours = path.join(root, "app", "node_modules");
  theirs = path.join(root, "glaze-sdk", "node_modules");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(ours, { recursive: true });
  fs.mkdirSync(theirs, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const link = (): string => path.join(scriptsDir, "node_modules");
/** The link's target WITHOUT following it — `realpath` throws on a dangling
 *  link, which is one of the states under test. */
const targetOf = (): string => path.resolve(scriptsDir, fs.readlinkSync(link()));

describe("ensureModuleResolution", () => {
  it("creates the link when there is none", () => {
    ensureModuleResolution(scriptsDir, ours);

    expect(fs.lstatSync(link()).isSymbolicLink()).toBe(true);
    expect(targetOf()).toBe(ours);
  });

  it("repoints a link aimed at another tree that still exists", () => {
    // The exact shape of the reported bug: the Glaze SDK's node_modules is
    // still on disk, so the link resolves — to a SECOND @playwright/test.
    fs.symlinkSync(theirs, link(), "dir");

    ensureModuleResolution(scriptsDir, ours);

    expect(targetOf()).toBe(ours);
  });

  it("repairs a dangling link", () => {
    fs.symlinkSync(theirs, link(), "dir");
    fs.rmSync(theirs, { recursive: true, force: true });
    // The trap the old code fell into, pinned so it cannot come back.
    expect(fs.existsSync(link())).toBe(false);
    expect(fs.lstatSync(link()).isSymbolicLink()).toBe(true);

    ensureModuleResolution(scriptsDir, ours);

    expect(targetOf()).toBe(ours);
    expect(fs.existsSync(link())).toBe(true);
  });

  it("leaves a correct link alone", () => {
    fs.symlinkSync(ours, link(), "dir");
    const before = fs.lstatSync(link()).ino;

    ensureModuleResolution(scriptsDir, ours);

    // Same inode: it was not removed and recreated. Rewriting it every run
    // would be a needless unlink/symlink race against any run already reading
    // through it.
    expect(fs.lstatSync(link()).ino).toBe(before);
    expect(targetOf()).toBe(ours);
  });

  it("does not delete a real directory someone installed there", () => {
    // Not ours to remove — an `npm install` in the scripts dir would put a real
    // tree here, and deleting it is destructive in a way a wrong symlink is not.
    fs.mkdirSync(link());
    fs.writeFileSync(path.join(link(), "marker"), "x");

    ensureModuleResolution(scriptsDir, ours);

    expect(fs.lstatSync(link()).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(link(), "marker"))).toBe(true);
  });

  it("resolves a relative link against the scripts dir before comparing", () => {
    // A relative target that already points at `ours` must NOT be rewritten;
    // comparing the raw string would see a mismatch and churn the link.
    fs.symlinkSync(path.relative(scriptsDir, ours), link(), "dir");
    const before = fs.lstatSync(link()).ino;

    ensureModuleResolution(scriptsDir, ours);

    expect(fs.lstatSync(link()).ino).toBe(before);
  });
});
