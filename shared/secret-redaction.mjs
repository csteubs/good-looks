// Strip secret values out of anything persisted or sent — the PURE half.
//
// WHY IT IS SHARED. The runner plan's R7 requires that whatever supplies a
// secret to a CI run must also feed the redaction, "or the CLI's own log output
// and any emitted report will contain the credential." Two spellings of
// "replace every secret with a placeholder" is a second chance to get the
// ordering rule below wrong, and getting it wrong leaks a tail of the value into
// a log that reads as fully redacted.
//
// The app's `main/services/secret-redaction.ts` keeps everything that needs a
// store: the snapshot, the two async readers, the Electron-side wiring. It
// imports this and re-exports it, so its callers see one module still.

export const REDACTED = "[redacted]";

/** What a variable's value looks like in trainer-visible output.
 *
 *  Distinct from `REDACTED` because it answers a different question. That one
 *  says "something was removed from this log for your safety"; this one says
 *  "the step used the variable you gave it, and the trainer is not going to
 *  print it back at you". Same machinery, because the ordering rule below is
 *  the part that is easy to get wrong. */
export const MASKED = "****";

/**
 * Replace every occurrence of every secret value with a placeholder.
 *
 * Longest-first, which matters: if one secret is a prefix of another
 * ("hunter2" and "hunter2!"), replacing the short one first would leave the
 * tail of the long one ("!") sitting in the output next to a [redacted] label
 * — a partial leak that reads as if it were fully redacted.
 *
 * Values shorter than 4 characters are skipped. A one- or two-character secret
 * would match constantly and turn the log into noise, and a log full of
 * [redacted] is a log nobody reads — which costs more than that secret's
 * exposure in a local file.
 *
 * `placeholder` exists for the trainer, which masks every VARIABLE value out of
 * its replay logs rather than only the secret ones — see `MASKED`. It shares
 * this function rather than reimplementing it because the longest-first pass
 * above is the part worth having exactly once.
 */
export function redact(text, secrets, placeholder = REDACTED) {
  if (!text || secrets.length === 0) return text;
  let out = text;
  const ordered = [...new Set(secrets.filter((s) => s.length >= 4))].sort(
    (a, b) => b.length - a.length,
  );
  for (const secret of ordered) {
    out = out.split(secret).join(placeholder);
  }
  return out;
}
