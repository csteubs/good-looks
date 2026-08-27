// WHERE A TEST'S SPEC IS, on the machine asking — the one rule.
//
// ── The bug this exists to end (R10) ──────────────────────────────────────
// `scriptPath` is stored ABSOLUTE, from the machine that recorded the test —
// somewhere under that machine's own home directory and app-support folder.
// Every reader then trusts it. Copy the library to a CI runner — which is the
// entire point of a portable bundle, and what R14's GitHub Action would do —
// and `path.relative(scriptsDir, scriptPath)` hands Playwright a
// `../../../../..`-prefixed path back up to the AUTHOR's home directory:
// outside the runner's scripts dir, and not a file that exists on it. The
// run reports "no tests found", which reads as "your tests are broken" rather
// than "your library did not resolve here" — and if every test in the suite
// resolves that way, the pipeline's diagnosis points at the wrong thing
// entirely.
//
// ── The rule ──────────────────────────────────────────────────────────────
// A stored path is usable ONLY if it is inside THIS machine's scripts
// directory. Otherwise the spec's position is DERIVED from the record. That is
// the same test `testStore.writeScript` already applies before writing —
// "only an existing path INSIDE the scripts dir is honoured" — applied on read
// too, where it was missing.
//
// Two consequences worth stating. On the authoring machine nothing changes at
// all: the stored path is inside the scripts dir, so it is returned untouched.
// And no migration is needed, because a record that resolves wrongly is
// re-derived rather than rewritten.
//
// ── An imported test keeps its position ───────────────────────────────────
// An imported spec lives in `imported/<id>/…` and relative-imports its
// siblings, so "the spec for this test" is a path INSIDE that sandbox, not a
// flat file. The position is recoverable from the stored path without knowing
// the old root: everything after the `imported/<id>/` segment is the part that
// was always relative.
//
// ── tests.json is untrusted input on a copied library ─────────────────────
// This is the half that is easy to miss. A bundle is a folder somebody hands
// you, exactly like an imported project, and its `tests.json` is a file they
// wrote. The derived path is JOINED onto the local scripts dir, so a `..`
// segment or an absolute tail would walk straight out of it — and unlike the
// import sandbox, this path is not copied to but READ and EXECUTED as a
// Playwright spec.
//
// So every derived segment is validated, and anything unusable falls back to
// the flat default rather than being honoured. The fallback never escapes,
// because it is built from the id alone and the id is checked first.
//
// Pure: strings in, strings out. `node:path` only, which is the same allowance
// `shared/branch-paths.mjs` takes — no fs, no IPC, no process.

import * as path from "node:path";

/** The directory an imported test's own sandbox sits in, under the scripts
 *  dir. Spelled here because `import-service.ts` builds the sandbox and this
 *  reads it back, and a second spelling is a spec nobody can find. */
export const IMPORTED_SEGMENT = "imported";

/** Where a library keeps its specs, given its recorder directory.
 *
 *  Three processes derive this — the app from `userData`, the MCP server and
 *  the CLI from the resolved data dir — and they were three joins of the same
 *  two segments. A run resolving a spec against a different directory from the
 *  one that wrote it is precisely the failure above, one level up. */
export function scriptsDirFor(recorderDir) {
  return path.join(recorderDir, "scripts");
}

/** A record id that is safe to build a path from.
 *
 *  Ids are uuids in practice, but this reads them out of a `tests.json` that a
 *  copied bundle brought with it — so "in practice" is the authoring machine's
 *  practice, not this one's. Anything with a separator, a `..`, a drive letter
 *  or a leading dot is refused. */
export function isSafeId(id) {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes("..");
}

/** One path segment that cannot walk anywhere. */
function isSafeSegment(segment) {
  return (
    typeof segment === "string" &&
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("/") &&
    !segment.includes("\\") &&
    !segment.includes("\0")
  );
}

/** Split a stored path on EITHER separator.
 *
 *  The path was written by whichever machine recorded the test, so a library
 *  authored on Windows carries `\` and one authored on macOS carries `/`. The
 *  reader is not necessarily either. */
function splitStored(stored) {
  return String(stored ?? "")
    .split(/[/\\]+/)
    .filter((s) => s.length > 0);
}

/**
 * Where this record's spec sits relative to the scripts directory, as segments.
 *
 * `["t-1.spec.ts"]` for a recorded test; `["imported", "<id>", "tests",
 * "a.spec.ts"]` for an imported one. Returns null when the id itself is
 * unusable — there is no safe default in that case, and inventing one would put
 * a file somewhere nobody asked for.
 *
 * @param {{id?: string, scriptPath?: string}} record
 * @returns {string[] | null}
 */
export function scriptRelSegments(record) {
  const id = record?.id;
  if (!isSafeId(id)) return null;
  const flat = [`${id}.spec.ts`];
  const parts = splitStored(record?.scriptPath);
  // The sandbox marker, read from the tail so a scripts dir that itself sits
  // under a folder called `imported` cannot be mistaken for one.
  const at = parts.lastIndexOf(IMPORTED_SEGMENT);
  if (at < 0 || parts[at + 1] !== id) return flat;
  const inside = parts.slice(at + 2);
  // A sandbox with nothing after it names a directory, not a spec.
  if (inside.length === 0 || !inside.every(isSafeSegment)) return flat;
  return [IMPORTED_SEGMENT, id, ...inside];
}

/** Whether `candidate` is `scriptsDir` itself or sits underneath it.
 *
 *  Resolved on both sides and requiring a separator at the boundary, so
 *  `/a/scripts-evil` is not read as living inside `/a/scripts`. Mirrors
 *  `isInside` in import-service.ts, which guards the same class of thing one
 *  directory over.
 *
 *  A RELATIVE candidate is refused outright, and that is load-bearing rather
 *  than tidy. `path.resolve` completes a relative path against `process.cwd()`,
 *  so without this the answer depends on where the process happens to have been
 *  started — `t-1.spec.ts` is "inside" only while the cwd is the scripts dir,
 *  and `resolveScriptPath` would then hand its caller the relative string it
 *  was given. The caller's next move is `path.relative(scriptsDir, specPath)`,
 *  which turns that into a `../../..` walk out of the library. Nothing the app
 *  writes is relative; a bundle's tests.json and a hand edit are where one comes
 *  from, and both are exactly the untrusted input this module exists for. */
export function isInsideScripts(scriptsDir, candidate) {
  if (!scriptsDir || !candidate) return false;
  if (!path.isAbsolute(candidate)) return false;
  const root = path.resolve(scriptsDir);
  const child = path.resolve(candidate);
  return child === root || child.startsWith(root + path.sep);
}

/**
 * The absolute path to this record's spec, on THIS machine.
 *
 * The stored path when it is usable here — which is every run on the machine
 * that recorded the test, so nothing changes there — and the derived position
 * otherwise. Null when the record names no spec this reader could find, which
 * a caller should report rather than paper over: a test whose spec cannot be
 * located is not a test that failed.
 *
 * @param {string} scriptsDir
 * @param {{id?: string, scriptPath?: string}} record
 * @returns {string | null}
 */
export function resolveScriptPath(scriptsDir, record) {
  if (!scriptsDir) return null;
  const stored = record?.scriptPath;
  if (stored && isInsideScripts(scriptsDir, stored)) return stored;
  const segments = scriptRelSegments(record);
  if (!segments) return null;
  const resolved = path.join(scriptsDir, ...segments);
  // Belt on a boundary the segment checks already hold. This path is READ AND
  // EXECUTED as a Playwright spec, and the input came out of somebody else's
  // tests.json, so the containment is asserted rather than assumed.
  return isInsideScripts(scriptsDir, resolved) ? resolved : null;
}
