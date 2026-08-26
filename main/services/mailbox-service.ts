// "Does the test mailbox actually answer?" — the question behind the Test
// button in Settings > Integrations.
//
// It exists because every other way of finding out is expensive. Without it a
// wrong token, a Worker deployed without its secret, or a URL missing its
// `/messages` path is discovered by recording a test, running it, and watching
// a sign-in step time out sixty seconds later — at which point the run names a
// mailbox and the user has no way to tell which of those three it was.
//
// What it proves and what it does not, stated plainly because the UI says so
// too: it proves the endpoint is reachable, the token is accepted, and the
// answer has the shape the run expects. It cannot prove that mail ROUTING
// works, because no mail has been sent. That is what the README's `curl` step
// is for.

import { logger } from "@shell/backend";

import { messagesUrl } from "../../shared/email-code.mjs";

import { mailboxStore } from "./mailbox-store.js";

/** Bounded so a hung endpoint does not hang the Settings pane. Generous
 *  against a cold Worker start, short against a black hole. */
const PROBE_TIMEOUT_MS = 10_000;

/** A syntactically valid address that is nobody's. RFC 2606 reserves
 *  example.com precisely so a probe cannot collide with a real mailbox — and
 *  the endpoint has to be asked for SOME address, since it refuses a request
 *  without one. */
const PROBE_ADDRESS = "probe@example.com";

export interface MailboxProbe {
  ok: boolean;
  detail: string;
}

/**
 * Ask the configured endpoint for a throwaway address and report what came
 * back, in terms the user can act on.
 *
 * Never throws: this backs a button, and an unhandled rejection here would
 * surface as a generic IPC failure that says less than any of the messages
 * below.
 */
export async function probeMailbox(): Promise<MailboxProbe> {
  const credentials = await mailboxStore.credentials();
  if (!credentials) {
    const status = await mailboxStore.status();
    return {
      ok: false,
      detail:
        status.state === "unreadable"
          ? "A mailbox is saved but its token could not be decrypted. Re-enter it."
          : "No mailbox is saved yet.",
    };
  }
  try {
    const response = await fetch(messagesUrl(credentials.endpoint, PROBE_ADDRESS, Date.now()), {
      headers: { authorization: `Bearer ${credentials.token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, detail: `The mailbox rejected the token (${response.status}).` };
    }
    if (response.status === 503) {
      return {
        ok: false,
        detail: "The Worker is deployed but has no token or KV binding configured.",
      };
    }
    if (response.status === 404) {
      return {
        ok: false,
        detail: "Not found — check the URL ends with /messages.",
      };
    }
    if (!response.ok) {
      return { ok: false, detail: `The mailbox answered ${response.status}.` };
    }
    const body = (await response.json()) as unknown;
    const messages = Array.isArray(body)
      ? body
      : (body as { messages?: unknown })?.messages;
    if (!Array.isArray(messages)) {
      // A 200 that is not the expected shape is worth its own message: it is
      // almost always a URL pointing at something else entirely that happens
      // to answer.
      return { ok: false, detail: "That URL answered, but not with a message list." };
    }
    return {
      ok: true,
      detail: "The mailbox answered. Mail routing is not checked by this test.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("mailbox", "The mailbox probe failed", { message });
    return {
      ok: false,
      detail: message.includes("timed out" ) || message.includes("abort")
        ? `No answer within ${PROBE_TIMEOUT_MS / 1000}s.`
        : `Could not reach the mailbox: ${message}`,
    };
  }
}
