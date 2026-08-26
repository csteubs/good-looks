// Types for worker.mjs. Hand-written, like the .d.mts files in shared/ — the
// Worker is plain ESM that wrangler bundles, and `@cloudflare/workers-types`
// is not a dependency of this repo (nothing in the app builds or runs it).
//
// These are structural stand-ins for the Cloudflare bindings: enough for
// `npm run type-check` to be a real gate over the test that boots this file,
// and no more. Widening one to `any` would defeat the only reason it exists.

/** The KV namespace binding, narrowed to what this Worker calls. */
export interface MailboxKv {
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: unknown },
  ): Promise<void>;
  get(key: string, type?: string): Promise<unknown>;
  list(options: { prefix: string }): Promise<{
    keys: Array<{ name: string; metadata?: unknown }>;
  }>;
}

export interface MailboxEnv {
  MAILBOX?: MailboxKv;
  MAILBOX_TOKEN?: string;
}

/** What Email Routing hands the `email()` handler. */
export interface InboundEmail {
  to?: string;
  from?: string;
  rawSize?: number;
  raw: unknown;
}

declare const worker: {
  email(message: InboundEmail, env: MailboxEnv): Promise<void>;
  fetch(request: Request, env: MailboxEnv): Promise<Response>;
};

export default worker;
