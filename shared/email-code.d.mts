// Types for email-code.mjs. Hand-written; see the other .d.mts files here.
//
// The implementation is plain ESM because two of its functions are embedded
// into the generated spec runtime as source text (`toString()`), which no
// build step is involved in — and this file is what keeps `npm run type-check`
// a real gate over the TypeScript callers (the mailbox store, the generator,
// the trainer's replay and the renderer's step rendering).

export declare const POLL_INTERVAL_MS: number;
export declare const POLL_BUDGET_MS: number;
export declare const DEFAULT_CODE_DIGITS: number;
export declare const MAX_ENDPOINT_LENGTH: number;
export declare const MAX_TOKEN_LENGTH: number;
export declare const MAX_ADDRESS_LENGTH: number;
export declare const MAX_BODY_SCAN: number;

/** One message as the mailbox endpoint returns it. Only what finding a code
 *  needs — the endpoint is a test fixture, not a mail archive. */
export interface MailboxMessage {
  subject?: string;
  body?: string;
  /** Unix milliseconds the endpoint received the message. */
  receivedAt?: number;
  from?: string;
  to?: string;
}

export interface CodeOptions {
  /** Digits in the code. Defaults to 6. */
  digits?: number;
  /** Plain text (never a pattern) the code must follow. */
  label?: string;
}

/** Why this endpoint may not be used, or null when it may. */
export declare function endpointProblem(value: unknown): string | null;

/** Why this token may not be used, or null when it may. */
export declare function tokenProblem(value: unknown): string | null;

/** Why this address may not be used, or null when it may. */
export declare function addressProblem(value: unknown): string | null;

/** The stored spelling of an address: trimmed and lower-cased. */
export declare function normalizeAddress(value: unknown): string;

/** The URL one poll requests. */
export declare function messagesUrl(endpoint: string, address: string, sinceMs: number): string;

/** The instant a message must beat to be believed: the later of run start and
 *  the last code this run consumed. */
export declare function codeWatermark(runStartedAt: number, lastConsumedAt: number): number;

/** The code inside one message, or null when it holds none. */
export declare function codeFromMessage(
  message: MailboxMessage,
  opts?: CodeOptions,
): string | null;

/** The newest message that beats the watermark and holds a code. */
export declare function pickCode(
  messages: MailboxMessage[],
  watermark: number,
  opts?: CodeOptions,
): { code: string; receivedAt: number } | null;

/** One raw RFC 5322 message reduced to what finding a code needs. Runs in the
 *  Cloudflare Worker; here so it cannot disagree with `codeFromMessage` about
 *  what `subject` and `body` are, and so it is covered by a test at all. */
export declare function parseMailMessage(
  raw: string,
  limit?: number,
): { subject: string; from: string; to: string; body: string };
