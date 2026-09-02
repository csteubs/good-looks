// What's new in Good Looks, as data.
//
// The insights report includes "what changed in the app since you last heard"
// — which needs a machine-readable changelog that ships INSIDE the build. A
// markdown file would need packaging rules and a parser; a TypeScript array
// needs neither, is type-checked, and editing it is the same one-file motion
// as editing a changelog.
//
// MAINTENANCE RULE: when `package.json`'s `version` is bumped, add an entry
// here (newest first, `version` matching exactly) in the same commit. An entry
// with no matching version bump never surfaces; a bump with no entry surfaces
// as a version change with nothing to say — both are visible, neither breaks.

export interface ReleaseNote {
  /** Must equal a `package.json` version string exactly — matching is by
   *  string identity and list position, never by semver parsing. */
  version: string;
  /** ISO date, informational only. */
  date: string;
  /** One line each, user-facing. */
  highlights: string[];
}

/** Newest first. Position is what "since" means — see `unseenNotes`. */
export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "1.1.0",
    date: "2026-09-01",
    highlights: [
      "Handle pop-ups: a run option that clicks away Klaviyo forms, DataGrail consent banners and the overlay rules you taught — on by default, off per test when the pop-up is the point.",
      "A new in-app guide, Pop-ups, banners and dialogs, in Settings → Documentation and the Help menu.",
    ],
  },
  {
    version: "1.0.0",
    date: "2026-08-18",
    highlights: [
      "AI insights reports: an optional scheduled summary of your suite's trends, risks and fixes, in Settings → Alerts.",
      "First tracked release — earlier changes predate these notes.",
    ],
  },
];

/**
 * The notes the reader hasn't heard yet.
 *
 * Positional, not semver: `lastSeen` is looked up in the list and everything
 * NEWER (earlier in the array) is unseen. Two edges handled explicitly:
 * - `lastSeen` null (first report ever): only the current version's own entry,
 *   never the whole history — a first report that opens with every note ever
 *   written reads as a changelog, not a digest.
 * - `lastSeen` not found (its entry was pruned, or the version string never
 *   had one): same fallback, the current version's entry, because "everything"
 *   would be a guess about how far back the reader's knowledge goes.
 */
export function unseenNotes(
  lastSeen: string | null,
  current: string,
  notes: readonly ReleaseNote[] = RELEASE_NOTES,
): ReleaseNote[] {
  if (lastSeen === current) return [];
  const currentOnly = notes.filter((n) => n.version === current);
  if (lastSeen === null) return currentOnly;
  const seenIndex = notes.findIndex((n) => n.version === lastSeen);
  if (seenIndex === -1) return currentOnly;
  return notes.slice(0, seenIndex);
}
