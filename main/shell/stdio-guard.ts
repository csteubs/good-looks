// Make writing to stdout/stderr unable to kill the app.
//
// ── The bug this exists for ────────────────────────────────────────────────
// A packaged Good Looks! showed the user this, repeatedly:
//
//     A JavaScript error occurred in the main process
//     Uncaught Exception: Error: write EPIPE
//       at Socket._writeGeneric (node:net:1026:11)
//       … at console.log … at log (…/build/main/index.js)
//
// `logger.ts` wrote to the console UNGUARDED while wrapping its file write in a
// try/catch marked "best-effort" — the file's own header says "a full disk must
// not take the recorder down with it", and the same reasoning had simply never
// been applied to the other write.
//
// stdout is a SOCKET, not a terminal, whenever the app is launched by another
// process (a terminal session, a script, an agent's shell). When that parent
// exits and the app does not, the socket's read end closes and every subsequent
// log line writes to a dead pipe. So the failure is not rare or exotic: it is
// the normal end state of "launch the app from a terminal, then close it".
//
// ── Why one guard is not enough ────────────────────────────────────────────
// Node delivers this error BOTH WAYS, which is the part that makes the obvious
// fix wrong. The reported stack is synchronous — `afterWriteDispatched` throws
// straight back out through `console.log`, so a try/catch catches it. But an
// EPIPE noticed after the write was dispatched arrives instead as an `error`
// EVENT on the stream, and an unhandled `error` event throws from the event
// loop where no try/catch can see it. Reproducing the orphaned-parent case
// produces the second kind; the user's dialog is the first. Guarding only one
// leaves the dialog exactly as often, for a different reason.
//
// ── Why this is not in logger.ts ───────────────────────────────────────────
// It is a process-level policy, not a logging detail — anything in the main
// process that writes to stdout is exposed to the same dead socket. Keeping it
// here also keeps it TESTABLE: `logger.ts` imports `electron`, and nothing in
// `vitest.config.ts` aliases that, so a test cannot load it. This module
// imports nothing.

/** Streams already carrying our no-op handler, so repeated calls cannot stack
 *  listeners and trip Node's max-listeners warning. */
const guarded = new WeakSet<object>();

/**
 * Swallow `error` events on the standard streams.
 *
 * Idempotent, and safe on a stream that is missing entirely: a process launched
 * with its stdio detached has `process.stdout === null`, and the guard for a
 * dead stream must not itself be the thing that throws.
 *
 * Deliberately a no-op handler rather than a log line. There is nowhere left to
 * report to — the stream we would report on is the broken one — and the file
 * log still receives everything, because `logger` writes it separately.
 */
export function guardStdio(
  streams: (NodeJS.WriteStream | null | undefined)[] = [process.stdout, process.stderr],
): void {
  for (const stream of streams) {
    if (!stream || typeof stream.on !== "function") continue;
    if (guarded.has(stream)) continue;
    guarded.add(stream);
    stream.on("error", () => {
      /* the pipe is gone; the file log is the trail that survives */
    });
  }
}

/**
 * Perform a console write that cannot throw.
 *
 * The synchronous half of the pair. `guardStdio` handles the error that arrives
 * as an event; this handles the one that comes straight back out of the call,
 * which is the half the user's stack trace showed.
 */
export function writeSafely(write: (text: string) => void, text: string): void {
  try {
    write(text);
  } catch {
    /* best-effort, exactly like the file write beside the caller */
  }
}
