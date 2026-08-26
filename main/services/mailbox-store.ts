// The test mailbox: where the emailed sign-in code is read from.
//
// One endpoint and one bearer token for the whole library, split across two
// files for the same reason `shopify-signature-store.ts` is:
//
//   • `mailbox.json` is a PLAINTEXT register — the endpoint and when it was
//     saved, and no token. It exists so the standalone MCP server, which has
//     no Electron and therefore no safeStorage, can tell "no mailbox
//     configured" from "one is, and I cannot read it". Without it the server's
//     only options are warning before every run or never warning at all.
//
//   • `mailbox-token.bin` holds the token, encrypted through
//     `createEncryptedSecretStore` like every other credential here.
//
// Three states are reported and `unreadable` is NEVER collapsed into `none`:
// a run that goes without a code because the keychain was locked must say so,
// because the failure it produces otherwise — a login step timing out — reads
// as a flaky test.
//
// The endpoint is not treated as a credential. It is guarded by the token, the
// Worker fails closed without one, and the whole point of the plaintext half
// is that something with no key can still describe the configuration. That is
// the same call the signature register makes about a host.
//
// Write order is asymmetric so a partial failure always leaves the VISIBLE
// state: register first when adding, blob first when removing, and
// `mailboxCredentials` requires BOTH halves — a token stranded without an
// endpoint is never sent anywhere.

import * as fs from "fs/promises";
import * as path from "path";

import { app, logger } from "@shell/backend";

import { endpointProblem, tokenProblem } from "../../shared/email-code.mjs";

import { createEncryptedSecretStore } from "./encrypted-secret-store.js";

export const MAILBOX_REGISTER_FILE = "mailbox.json";
export const MAILBOX_SECRET_FILE = "mailbox-token.bin";

const VERSION = 1;

const secretStore = createEncryptedSecretStore({
  fileName: MAILBOX_SECRET_FILE,
  label: "test mailbox token",
});

/** What the app and the MCP can say about the mailbox without decrypting it. */
export type MailboxState = "none" | "configured" | "unreadable";

export interface MailboxStatus {
  state: MailboxState;
  /** Present whenever a register exists — the host, for a Settings row that
   *  says "Reading from mailbox.example.workers.dev" without handing back the
   *  token. */
  host?: string;
  endpoint?: string;
  savedAt?: number;
}

interface RegisterFile {
  version: number;
  endpoint?: string;
  savedAt?: number;
}

function registerPath(): string {
  return path.join(app.getPath("userData"), "recorder", MAILBOX_REGISTER_FILE);
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT";
}

async function readRegister(): Promise<RegisterFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(registerPath(), "utf-8");
  } catch (error) {
    if (!isFileNotFound(error)) {
      logger.warn("secrets", "The mailbox register could not be read; treating it as absent");
    }
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as RegisterFile;
    if (!parsed || typeof parsed !== "object") return null;
    // Re-validated on READ, not only on write. The file is on disk and a
    // hand-edited or half-written one must not put an endpoint the app would
    // refuse to accept into a run's environment.
    if (endpointProblem(parsed.endpoint) !== null) return null;
    return { version: VERSION, endpoint: parsed.endpoint, savedAt: Number(parsed.savedAt) || 0 };
  } catch {
    logger.warn("secrets", "The mailbox register is not valid JSON; ignoring it");
    return null;
  }
}

async function writeRegister(body: RegisterFile): Promise<void> {
  const target = registerPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tempPath = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(body, null, 2), "utf-8");
    await fs.rename(tempPath, target);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

function hostOf(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  try {
    return new URL(endpoint).host;
  } catch {
    return undefined;
  }
}

export const mailboxStore = {
  /** Why this pair may not be saved, or null when it may. Both halves, so the
   *  dialog reports the first real problem rather than saving an endpoint and
   *  then rejecting the token. */
  problem(endpoint: unknown, token: unknown): string | null {
    return endpointProblem(endpoint) ?? tokenProblem(token);
  },

  /** Save both halves. Register FIRST: if the blob write then fails, the app
   *  reports `unreadable` — which is visible and true — where the other order
   *  would leave a token nothing can find and a UI saying nothing is
   *  configured. */
  async set(endpoint: string, token: string): Promise<void> {
    const problem = mailboxStore.problem(endpoint, token);
    if (problem) throw new Error(problem);
    await writeRegister({ version: VERSION, endpoint: String(endpoint).trim(), savedAt: Date.now() });
    await secretStore.set(token);
  },

  /** Remove both halves. Blob FIRST, for the mirror of the reason above: a
   *  removal that half-fails must never leave the token behind. */
  async clear(): Promise<void> {
    await secretStore.clear();
    await fs.rm(registerPath(), { force: true });
  },

  /** What can be said without decrypting. `unreadable` means a register exists
   *  and the token could not be read — never folded into `none`. */
  async status(): Promise<MailboxStatus> {
    const register = await readRegister();
    if (!register || !register.endpoint) return { state: "none" };
    const base = {
      endpoint: register.endpoint,
      host: hostOf(register.endpoint),
      savedAt: register.savedAt,
    };
    const token = await secretStore.get();
    if (token === null) return { state: "unreadable", ...base };
    return { state: "configured", ...base };
  },

  /** Test seam — drops the in-process cache so the next read hits disk. Same
   *  seam the sibling stores expose, and needed for the same reason: a test
   *  that deletes the file behind the store's back is otherwise answered from
   *  the cache, so the case it meant to set up never happens. */
  resetCache(): void {
    secretStore.resetCache();
  },

  /** Both halves or nothing. A run is armed from this, so a partial
   *  configuration must not produce a request with an empty Authorization
   *  header — that reads as a rejected token rather than a missing one. */
  async credentials(): Promise<{ endpoint: string; token: string } | null> {
    const register = await readRegister();
    if (!register || !register.endpoint) return null;
    const token = await secretStore.get();
    if (!token || tokenProblem(token) !== null) return null;
    return { endpoint: register.endpoint, token };
  },
};
