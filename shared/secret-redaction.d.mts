/** What a redacted value looks like in a persisted log or an outgoing payload. */
export declare const REDACTED: string;

/** What a variable's value looks like in trainer-visible output. Distinct from
 *  `REDACTED` because it answers a different question — that one says something
 *  was removed for your safety, this one says the trainer is not going to print
 *  your variable back at you. */
export declare const MASKED: string;

/**
 * Replace every occurrence of every secret value with a placeholder.
 *
 * Longest-first, which is load-bearing: if one secret is a prefix of another
 * ("hunter2" / "hunter2!"), replacing the short one first leaves the tail of the
 * long one sitting next to a [redacted] label — a partial leak that reads as if
 * it were fully redacted. Values shorter than 4 characters are skipped.
 */
export declare function redact(
  text: string,
  secrets: readonly string[],
  placeholder?: string,
): string;
