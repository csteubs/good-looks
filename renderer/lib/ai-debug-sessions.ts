// Pure rules for the set of AI debug sessions.
//
// Kept out of the React store (ai-debug-store.tsx) for the same reason
// paginate.ts / batch-order.ts / run-filters.ts are kept out of their views:
// these rules have failure modes that read as "my job vanished" or "it says
// it's still thinking but nothing is running", not as errors — so they need to
// be exercisable without React, a provider, or the design system.

import type { AiDebugKind, AiDebugSession, AiDebugStatus } from "./recorder-types";
import { isTerminal } from "./ai-debug-status";

/** The subset these rules actually read. Typed structurally so they work on
 *  both a full session and the store's content-free metadata — the store splits
 *  those apart so a streamed token doesn't re-render every icon in the app. */
export interface SessionLike {
  key: string;
  status: AiDebugStatus;
  startedAt: number;
  updatedAt: number;
}

/** Concurrent STREAMING sessions. Local providers (Ollama / LM Studio) serve
 *  requests one at a time, so an unbounded fan-out leaves several icons orange
 *  while nothing actually progresses — the colour would be lying. Blocking the
 *  third send with a clear message is the honest behaviour. */
export const MAX_ACTIVE_STREAMS = 2;

/** Retained sessions, newest first. Matches the run-history cap idiom. */
export const MAX_SESSIONS = 20;

export function runSessionKey(testId: string): string {
  return `run:${testId}`;
}

export function stepSessionKey(testId: string, stepIndex: number): string {
  return `step:${testId}:${stepIndex}`;
}

/** Inverse of the key builders. Returns null for anything unrecognized rather
 *  than guessing — a malformed key from a corrupt file must not become a
 *  plausible-looking session. */
export function parseSessionKey(
  key: string,
): { kind: AiDebugKind; testId: string; stepIndex: number | null } | null {
  if (key.startsWith("run:")) {
    const testId = key.slice(4);
    return testId ? { kind: "run", testId, stepIndex: null } : null;
  }
  if (key.startsWith("step:")) {
    const rest = key.slice(5);
    const at = rest.lastIndexOf(":");
    if (at <= 0) return null;
    const testId = rest.slice(0, at);
    const stepIndex = Number(rest.slice(at + 1));
    if (!testId || !Number.isInteger(stepIndex) || stepIndex < 0) return null;
    return { kind: "step", testId, stepIndex };
  }
  return null;
}

/** FNV-1a, 32-bit, hex. Not a cryptographic hash and not meant to be — it only
 *  answers "is this the same script text the prompt was built from?", and it
 *  needs to be dependency-free and stable across restarts. */
export function hashScript(source: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    // Math.imul keeps the multiply in 32-bit space; `h * 16777619` would lose
    // precision past 2^53 and make the hash input-order-dependent in a way that
    // differs between engines.
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** True when the script has been edited since this session's prompt was built,
 *  so applying its diff would clobber changes the model never saw.
 *
 *  Unknown on either side is NOT stale: a session from before hashing existed,
 *  or a script that hasn't loaded yet, must not raise a false alarm on every
 *  restore. */
export function isStale(session: Pick<AiDebugSession, "scriptHash">, liveScript: string | null): boolean {
  if (!session.scriptHash || liveScript === null) return false;
  return hashScript(liveScript) !== session.scriptHash;
}

export type StartDecision =
  | { ok: true }
  | { ok: false; reason: "at-capacity"; oldestStreamingKey: string | null };

/** Whether another stream may start. `exceptKey` is the session about to be
 *  (re)started — restarting one that is already streaming replaces its own
 *  request, so it must not count against itself and lock the user out of the
 *  very session they're looking at. */
export function canStartStream(sessions: SessionLike[], exceptKey?: string): StartDecision {
  const streaming = sessions.filter((s) => s.status === "streaming" && s.key !== exceptKey);
  if (streaming.length < MAX_ACTIVE_STREAMS) return { ok: true };
  const oldest = streaming.reduce<SessionLike | null>(
    (acc, s) => (acc === null || s.startedAt < acc.startedAt ? s : acc),
    null,
  );
  return { ok: false, reason: "at-capacity", oldestStreamingKey: oldest?.key ?? null };
}

/** Which status the single global chip shows when several sessions exist.
 *
 *  Priority is by how much it wants the user's attention, NOT by recency:
 *  error and done are actionable, streaming is merely informational. A finished
 *  job hiding behind a still-running one is the exact "come back when it's
 *  ready" failure this feature exists to prevent. */
const STATUS_PRIORITY: AiDebugStatus[] = [
  "error",
  "done",
  "streaming",
  "interrupted",
  "cancelled",
  "idle",
];

export function aggregateStatus(sessions: SessionLike[]): AiDebugStatus | null {
  if (sessions.length === 0) return null;
  for (const status of STATUS_PRIORITY) {
    if (sessions.some((s) => s.status === status)) return status;
  }
  return null;
}

/** Newest activity first — the order the chip's list and any session picker use. */
export function sortSessions<T extends SessionLike>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Cap the retained set, newest first.
 *
 *  A STREAMING session is never evicted, however old it is: dropping it would
 *  strand a live backend request with no one holding its requestId, which is
 *  precisely the orphaned-request leak this store exists to prevent. */
export function pruneSessions<T extends SessionLike>(sessions: T[], max = MAX_SESSIONS): T[] {
  if (sessions.length <= max) return sortSessions(sessions);
  const sorted = sortSessions(sessions);
  const kept: T[] = [];
  const overflow: T[] = [];
  for (const s of sorted) {
    if (kept.length < max) kept.push(s);
    else overflow.push(s);
  }
  // Re-admit any live session that fell past the cap, trading away the oldest
  // terminal entries instead.
  const strandedLive = overflow.filter((s) => !isTerminal(s.status));
  if (strandedLive.length === 0) return kept;
  const droppable = kept.filter((s) => isTerminal(s.status));
  const undroppable = kept.filter((s) => !isTerminal(s.status));
  const room = Math.max(0, max - undroppable.length - strandedLive.length);
  return sortSessions([...undroppable, ...strandedLive, ...droppable.slice(0, room)]);
}
