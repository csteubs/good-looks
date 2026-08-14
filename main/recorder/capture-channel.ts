// How a captured step gets OUT of the page, and how the backend decides which
// arrivals are new.
//
// ── The bug this exists for ────────────────────────────────────────────────
// A click that navigates was recorded by the page and then lost. The capture
// script pushed the step onto `data-pw-queue`, an attribute of the document
// that the click was in the process of destroying, and the backend read that
// attribute on a 250 ms poll (plus a best-effort read on `will-navigate`).
// Every one of those reads is an async round-trip into the renderer: by the
// time it ran, the document holding the queue was gone and the answer was an
// empty array or a rejection. The user saw the page transition with no step
// recorded — worst of all on the clicks that matter most, the ones that move
// between routes — and had no way back, because the training browser's URL
// strip is read-only.
//
// The queue was never the wrong PLACE to put a step. It was the wrong place to
// LEAVE one. So the page now pushes each step out the instant it is captured,
// synchronously, inside the same event dispatch as the click:
//
//   page  ──console.debug("<prefix>{…}")──▶  webContents "console-message"
//
// A console message is handed to the browser process at the moment of the call.
// It does not wait for a poll, it is not read back out of the document, and it
// is not subject to the page's CSP (which rules out `sendBeacon`/`fetch`, both
// of which a strict site can forbid). Whatever happens to the document
// afterwards, the step has already left.
//
// The DOM queue stays, as the second of two independent channels. Both carry
// the same `(doc, seq)` identity, and `CaptureLedger` below is what makes
// running two channels safe: it admits each step exactly once, in the order the
// page captured it.
//
// ── The nonce ──────────────────────────────────────────────────────────────
// The console channel is authenticated by a per-session nonce that the backend
// generates and interpolates into the injected script. That script runs in an
// ISOLATED WORLD, so the nonce lives in a closure the page's own scripts cannot
// read — unlike `data-pw-queue`, which is an attribute any script can write.
// A page can therefore not forge a step through this channel, which makes it
// strictly the stronger of the two boundaries. Steps are still rebuilt by
// `normalizeRawStep` regardless: the trust boundary is the same one, and
// "unforgeable today" is a property of the current code.
//
// Pure module: no electron, no fs, no IPC. It is imported by the injected
// script's builder (for the prefix) and by the service (for everything else).

/** Line prefix that marks a console message as a captured step. Long and
 *  distinctive on purpose: every console message an arbitrary website emits is
 *  tested against it, so it has to be cheap to reject and impossible to hit by
 *  accident. */
export const CAPTURE_MESSAGE_PREFIX = "__GOODLOOKS_STEP__";

/** Hard cap on a single console message we will even try to parse. A page can
 *  log megabytes; a step is a few hundred bytes. */
export const MAX_CAPTURE_MESSAGE_BYTES = 256_000;

/** One step as it left the page, with the identity that lets two channels
 *  deliver it without it being recorded twice. */
export interface CaptureEntry {
  /** identity of the DOCUMENT that captured it — a fresh random string per
   *  document, so `seq` restarting after a navigation cannot collide */
  doc: string;
  /** 1-based position within that document's captures */
  seq: number;
  /** the raw page-authored step. Deliberately `unknown`: normalization is the
   *  service's job and must not be skippable by anything that builds one of
   *  these. */
  step: unknown;
}

/** What the drain script answers with. */
export interface DrainPayload {
  doc: string;
  /** whether the capture script is still installed in this document. False is
   *  the signal to re-inject — see `CaptureLedger`'s note on self-healing. */
  installed: boolean;
  entries: CaptureEntry[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** A doc id we are willing to key a ledger on: a non-empty, bounded string. */
function docId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > 64) return null;
  return s;
}

function seqOf(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) return null;
  return v;
}

/**
 * Read a console message as a captured step, or answer null.
 *
 * `nonce` is checked before anything else is trusted. Every message an
 * arbitrary website prints reaches here, so a mismatch is the normal case, not
 * an error worth logging.
 */
export function parseCaptureMessage(message: unknown, nonce: string): CaptureEntry | null {
  if (typeof message !== "string") return null;
  if (!nonce) return null;
  if (message.length > MAX_CAPTURE_MESSAGE_BYTES) return null;
  if (!message.startsWith(CAPTURE_MESSAGE_PREFIX)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(message.slice(CAPTURE_MESSAGE_PREFIX.length));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed.n !== nonce) return null;

  const doc = docId(parsed.d);
  const seq = seqOf(parsed.i);
  if (!doc || seq === null) return null;
  if (parsed.s === undefined) return null;
  return { doc, seq, step: parsed.s };
}

/**
 * Read the drain script's answer.
 *
 * Everything in it is page-writable (the queue is a DOM attribute), so this
 * only decides SHAPE. Returns null when the payload is unusable, which the
 * caller treats as "nothing to ingest" rather than as an error — a page
 * mid-navigation answers with junk as a matter of course.
 */
export function parseDrainPayload(json: unknown): DrainPayload | null {
  if (typeof json !== "string" || !json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const doc = docId(parsed.d) ?? "";
  const installed = parsed.installed === 1 || parsed.installed === true;
  const entries: CaptureEntry[] = [];
  if (Array.isArray(parsed.q) && doc) {
    for (const raw of parsed.q) {
      if (!isPlainObject(raw)) continue;
      const seq = seqOf(raw.i);
      if (seq === null || raw.s === undefined) continue;
      entries.push({ doc, seq, step: raw.s });
    }
  }
  return { doc, installed, entries };
}

/** How long a gap in the sequence is held open before the steps behind it are
 *  released anyway. Longer than a poll interval by several multiples: the whole
 *  point of the wait is to give the SECOND channel time to supply the step the
 *  first one dropped. */
export const GAP_GRACE_MS = 1200;
/** Ceiling on steps held behind one gap. Reaching it means the missing step is
 *  never coming; releasing beats hoarding. */
export const MAX_PENDING_PER_DOC = 200;
/** How many documents' sequences are tracked at once. One per page load; a few
 *  is plenty, and the cap is what stops a session that visits 500 pages from
 *  growing a map with 500 entries in it. */
export const MAX_TRACKED_DOCS = 8;

interface DocState {
  /** the next sequence number that may be emitted */
  next: number;
  /** arrivals that came in ahead of a gap, keyed by seq */
  pending: Map<number, unknown>;
  /** when the oldest current pending entry arrived */
  waitingSince: number;
}

/**
 * Decides which arrivals are new, and hands them back IN CAPTURE ORDER.
 *
 * Two channels deliver the same steps, so the naive answer — a set of ids seen
 * — is wrong in a way that is silent: it admits a step that arrives late (the
 * console message that was dropped, supplied a beat later by the drain) AFTER
 * steps that were captured after it, and a step list in the wrong order is a
 * test that does the right things in the wrong sequence. Nothing downstream can
 * tell.
 *
 * So this is a resequencer, not a filter:
 *   • seq < next  → already emitted; dropped
 *   • seq = next  → emitted, along with anything queued behind it
 *   • seq > next  → held, because something earlier has not arrived yet
 *
 * `sweep` is the release valve: a gap that has waited past GAP_GRACE_MS is one
 * neither channel is going to fill, and holding the steps behind it forever
 * would turn one dropped message into a recorder that stops recording. Late is
 * better than never, and both are better than out of order.
 */
export class CaptureLedger {
  private docs = new Map<string, DocState>();

  /** Steps that are now ready to record, in order. Usually one; empty when the
   *  arrival was a duplicate or is waiting behind a gap. */
  admit(entry: CaptureEntry, now: number): unknown[] {
    const out: unknown[] = [];
    let state = this.docs.get(entry.doc);
    if (!state) {
      state = { next: 1, pending: new Map(), waitingSince: now };
      // Evicting an old document must not drop what it was still holding: a
      // step recovered out of order is worth more than one silently discarded.
      while (this.docs.size >= MAX_TRACKED_DOCS) {
        const oldest = this.docs.keys().next();
        if (oldest.done) break;
        out.push(...this.releasePending(oldest.value as string));
        this.docs.delete(oldest.value as string);
      }
      this.docs.set(entry.doc, state);
    }

    if (entry.seq < state.next) return out;
    if (entry.seq > state.next) {
      if (!state.pending.has(entry.seq)) {
        if (state.pending.size === 0) state.waitingSince = now;
        state.pending.set(entry.seq, entry.step);
      }
      if (state.pending.size > MAX_PENDING_PER_DOC) {
        out.push(...this.releasePending(entry.doc));
      }
      return out;
    }

    out.push(entry.step);
    state.next = entry.seq + 1;
    while (state.pending.has(state.next)) {
      out.push(state.pending.get(state.next));
      state.pending.delete(state.next);
      state.next++;
    }
    if (state.pending.size === 0) state.waitingSince = now;
    return out;
  }

  /** Release anything that has been waiting behind a gap for too long. Called
   *  on the poll, after the drain has had its chance to fill it. */
  sweep(now: number): unknown[] {
    const out: unknown[] = [];
    for (const [doc, state] of this.docs) {
      if (state.pending.size === 0) continue;
      if (now - state.waitingSince < GAP_GRACE_MS) continue;
      out.push(...this.releasePending(doc));
    }
    return out;
  }

  /** True while something is held behind a gap — used only by tests and the
   *  end-of-session log line. */
  pendingCount(): number {
    let n = 0;
    for (const state of this.docs.values()) n += state.pending.size;
    return n;
  }

  reset(): void {
    this.docs.clear();
  }

  private releasePending(doc: string): unknown[] {
    const state = this.docs.get(doc);
    if (!state || state.pending.size === 0) return [];
    const seqs = [...state.pending.keys()].sort((a, b) => a - b);
    const out = seqs.map((s) => state.pending.get(s));
    state.next = (seqs[seqs.length - 1] as number) + 1;
    state.pending.clear();
    return out;
  }
}
