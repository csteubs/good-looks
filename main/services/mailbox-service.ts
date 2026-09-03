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
import { appFetch, describeFetchError } from "./proxy-service.js";

/** Bounded so a hung endpoint does not hang the Settings pane. Generous
 *  against a cold Worker start, short against a black hole. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * The whole probe under one deadline, not just the request.
 *
 * `AbortSignal.timeout` alone is not enough once the call goes through
 * `appFetch`: the signal only reaches the request, and `appFetch` awaits a
 * proxy DECISION first — in automatic mode a `session.resolveProxy` call that
 * evaluates a PAC file, in manual mode a `safeStorage` decrypt of the proxy
 * password. Neither takes the signal. A PAC host that accepts connections and
 * never answers would hang the Settings pane past the bound, and then fail the
 * request instantly against an already-fired signal — reporting "no answer"
 * about an endpoint nothing had contacted.
 *
 * So the timer races the whole call and aborts it as it fires: whichever stage
 * is slow, the pane gets an answer at the bound.
 */
async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`timed out after ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
    // `appFetch`, not the global one. This request is made BY THE APP, from
    // the main process, so it is app traffic and Settings > Proxy reaches app
    // traffic only through here. A probe that went direct on a machine whose
    // app traffic is proxied is not testing the path anything else uses.
    //
    // What it therefore does NOT do is predict the run's transport, and that
    // is worth stating because it is the obvious thing to assume. A run polls
    // this same endpoint through `page.request.fetch`, so it takes the
    // browser context's proxy — the TEST class — while this takes the APP
    // class. With `proxyTraffic` set to "both" or "none" the two agree; set to
    // one class only, they do not, and the button still answers the question
    // it asks: is the mailbox reachable, with this token, from this app.
    const response = await withDeadline(
      (signal) =>
        appFetch(messagesUrl(credentials.endpoint, PROBE_ADDRESS, Date.now()), {
          headers: { authorization: `Bearer ${credentials.token}` },
          signal,
        }),
      PROBE_TIMEOUT_MS,
    );
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
    // `describeFetchError`, not `error.message`, for everything that is not the
    // deadline: going through the proxy adds failure modes undici reports as a
    // bare "fetch failed" with the cause several links down — a refused
    // CONNECT, a 407, a proxy that re-signs traffic. This module exists to
    // separate causes that otherwise look identical, and an unreadable fourth
    // one would send someone to re-paste a token that was never the problem.
    return {
      ok: false,
      detail:
        message.includes("timed out") || message.includes("abort")
          ? `No answer within ${PROBE_TIMEOUT_MS / 1000}s.`
          : `Could not reach the mailbox: ${describeFetchError(error)}`,
    };
  }
}
