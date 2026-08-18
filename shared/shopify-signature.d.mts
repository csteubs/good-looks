// Types for shopify-signature.mjs. See run-pacing.d.mts for why these are
// hand-written.

/** How much life a signature has left. `unknown` is a real state, not a
 *  fallback: `expires` is optional in RFC 9421 and is never invented here. */
export type SignatureState = "valid" | "expiring" | "expired" | "unknown";

export interface ParsedSignatureInput {
  /** Unix SECONDS, as the header carries it. */
  createdAt: number | null;
  /** Unix SECONDS, as the header carries it. Null when the value carried none. */
  expiresAt: number | null;
  keyId: string | null;
  alg: string | null;
  tag: string | null;
}

export declare const SIGNATURE_HEADER_NAMES: readonly string[];
/** Quotes included — the header is a structured-field String. */
export declare const SIGNATURE_AGENT_VALUE: string;
export declare const EXPIRY_WARN_DAYS: number;
export declare const MAX_HEADER_VALUE_LENGTH: number;

export declare function parseSignatureInput(raw: string): ParsedSignatureInput | null;
/** Why a pasted header value is unacceptable, or null when it is fine. */
export declare function headerValueProblem(raw: string, label?: string): string | null;
export declare function validateHeaderValue(raw: string): string | null;
export declare function normalizeSignatureHost(raw: string): string | null;
export declare function signatureState(input: {
  /** Unix SECONDS. */
  expiresAt: number | null | undefined;
  /** Milliseconds, as `Date.now()` gives it. */
  nowMs: number;
}): SignatureState;
/** Exact host match, and null for an expired entry. */
export declare function signatureForUrl<T extends { host: string; expiresAt?: number | null }>(
  entries: readonly T[],
  url: string,
  nowMs: number,
): T | null;
