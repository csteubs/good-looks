// What the ⌘K palette is made of, and how a query picks from it. REDESIGN §6.7.
//
// PURE, AND SEPARATE FROM THE OVERLAY, for the reason that keeps coming up in
// this repo: the interesting part of a palette is not the box, it is which row
// is first. "Typing `stat` puts Stats above `Checkout — happy path`" is a claim
// about ranking, and it is testable here as arithmetic instead of as a list of
// DOM nodes under a runner with no layout engine.
//
// THE SCORING IS DELIBERATELY SMALL. Three tiers and a tie-break, not a fuzzy
// library:
//
//   1. The title starts with what you typed.
//   2. A WORD in the title starts with it — so "hap" finds "Checkout — happy
//      path" without also promoting every title that merely contains "hap"
//      somewhere in the middle of a word.
//   3. The letters appear in order anywhere (a subsequence), which is what
//      makes "chp" reach "CHeckout — happy Path".
//
// Anything a general fuzzy matcher does beyond that is guessing, and a palette
// that guesses is one where the top row moves for reasons the user cannot see.
// A wrong FIRST row is the only failure mode this feature really has: nobody
// reads the list, they type three letters and press Enter.
//
// Matches on `keywords` always score below matches on the title, whatever the
// tier. A hostname or a tag list is context, not a name, and a test whose URL
// happens to contain "stats" must not outrank the Stats view.

/** Which block of the list a command belongs to. The order here IS the order
 *  the groups render in, so it is a decision rather than a type: actions first
 *  because they are what somebody opened the palette to do, views last because
 *  the rail already lists them and the palette is the slower way to get there. */
export const GROUP_ORDER = ["Actions", "Tests", "Tags", "Views"] as const;

export type CommandGroup = (typeof GROUP_ORDER)[number];

export interface Command {
  id: string;
  /** What the row reads. Also what the query is matched against, first. */
  title: string;
  group: CommandGroup;
  /** Searchable but not displayed — a hostname, a tag list, a synonym. Always
   *  ranked below a title match. */
  keywords?: string;
  /** Right-aligned on the row. A count, a host, a shortcut. Never matched. */
  hint?: string;
  run: () => void;
}

/** Tiers, spaced far enough apart that no length bonus can cross between them.
 *  Named, because the gaps ARE the ranking and a reader should not have to
 *  reverse them out of the arithmetic. */
const TITLE_PREFIX = 1000;
const TITLE_WORD = 700;
const TITLE_SUBSEQ = 400;
const KEYWORD_PREFIX = 300;
const KEYWORD_WORD = 200;
const KEYWORD_SUBSEQ = 100;

/** Do `query`'s characters appear in `text`, in order? The loosest tier. */
export function isSubsequence(query: string, text: string): boolean {
  if (query.length === 0) return true;
  let q = 0;
  for (let i = 0; i < text.length && q < query.length; i++) {
    if (text[i] === query[q]) q++;
  }
  return q === query.length;
}

/** Does any word in `text` start with `query`?
 *
 *  Words are split on anything that is not a letter or a digit, so "Checkout —
 *  happy path" yields checkout/happy/path and "run:t-login" yields run/t/login.
 *  Splitting on spaces alone would make a hyphenated or punctuated title
 *  reachable only from its first word. */
export function hasWordPrefix(query: string, text: string): boolean {
  for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
    if (word.length > 0 && word.startsWith(query)) return true;
  }
  return false;
}

/**
 * How well one command answers one query. `null` means it does not.
 *
 * The length term is a TIE-BREAK inside a tier and never a tier of its own:
 * with two prefix matches, the shorter title is the more likely intent
 * ("Stats" over "Stats — flake report"). It is capped well below the gap
 * between tiers so a short subsequence match can never outrank a long prefix
 * one — which is the specific way a hand-rolled scorer usually goes wrong.
 */
export function scoreCommand(query: string, command: Command): number | null {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 0;

  const title = command.title.toLowerCase();
  const keywords = command.keywords?.toLowerCase();

  const shortnessBonus = Math.max(0, 50 - command.title.length);

  if (title.startsWith(q)) return TITLE_PREFIX + shortnessBonus;
  if (hasWordPrefix(q, title)) return TITLE_WORD + shortnessBonus;
  if (isSubsequence(q, title)) return TITLE_SUBSEQ + shortnessBonus;

  if (keywords !== undefined) {
    if (keywords.startsWith(q)) return KEYWORD_PREFIX + shortnessBonus;
    if (hasWordPrefix(q, keywords)) return KEYWORD_WORD + shortnessBonus;
    if (isSubsequence(q, keywords)) return KEYWORD_SUBSEQ + shortnessBonus;
  }

  return null;
}

/**
 * The list, filtered and ordered.
 *
 * WITH AN EMPTY QUERY THE ORDER IS THE ONE IT WAS GIVEN — not alphabetical, not
 * scored. A palette that opens on a list is a menu, and the caller is the only
 * thing that knows what belongs at the top of it. Scoring an empty query would
 * sort by title length, which is a ranking by accident.
 *
 * WITH A QUERY, GROUPS STOP MATTERING. The best answer goes first even if its
 * group is last: someone who typed `sta` and meant Stats should not have to
 * scroll past four tests to reach it because Tests is the earlier block. Groups
 * are a way to read a list you are browsing, not a filter on one you are
 * searching. Ties keep their given order, so the list never jitters between two
 * commands the query cannot tell apart.
 */
export function filterCommands(query: string, commands: readonly Command[]): Command[] {
  if (query.trim().length === 0) return [...commands];

  const scored: { command: Command; score: number; index: number }[] = [];
  commands.forEach((command, index) => {
    const score = scoreCommand(query, command);
    if (score !== null) scored.push({ command, score, index });
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.command);
}

/** The list broken into its blocks, in `GROUP_ORDER`, dropping empty ones.
 *
 *  Only used when the query is empty — see `filterCommands`. A searched list is
 *  rendered flat, because its order is the answer and re-grouping it would
 *  destroy exactly the information the search produced. */
export function groupCommands(commands: readonly Command[]): {
  group: CommandGroup;
  commands: Command[];
}[] {
  return GROUP_ORDER.map((group) => ({
    group,
    commands: commands.filter((c) => c.group === group),
  })).filter((g) => g.commands.length > 0);
}

/** Wrap the selection at both ends.
 *
 *  Wrapping rather than clamping: the list is short and the first row is the
 *  one people want, so pressing Up from it to reach the last is a shortcut
 *  rather than an accident. Guarded against an empty list, which happens on
 *  every query that matches nothing. */
export function moveSelection(current: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return (((current + delta) % length) + length) % length;
}

/**
 * The selection, made safe against a list that changed under it.
 *
 * `-1` means "nothing to select", which is every query that matches nothing.
 *
 * THE CASE THIS EXISTS FOR IS NOT THE KEYBOARD. Typing resets the selection to
 * the top, so no sequence of keystrokes can leave it past the end. What can is
 * a background refetch: the palette holds the `["tests"]` query live while it
 * is open, and a test deleted in another window shortens the list with no
 * input at all. Left unclamped, the row the user is looking at is gone and
 * Enter does nothing — which reads as a dead key rather than as a stale list.
 */
export function clampSelection(selected: number, length: number): number {
  if (length === 0) return -1;
  return Math.min(Math.max(selected, 0), length - 1);
}
