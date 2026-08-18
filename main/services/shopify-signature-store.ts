// The Shopify crawler signatures registered on this machine: the three header
// values, encrypted, plus a plaintext register of what exists.
//
// ── Why TWO files, when test-secrets-store.ts argues for one ──────────────
// That store keeps everything in one encrypted blob, on the reasoning that
// llm-service shipped a bug where `hasKey()` (file exists) and `getKey()`
// (decrypt succeeds) disagreed, and the app claimed a provider was connected
// that could not authenticate. That argument is right, and it is about a store
// answering ONE question two ways.
//
// This store answers two different questions, and the second one is asked from
// a process that cannot decrypt anything. The standalone MCP server is plain
// node with no Electron and therefore no safeStorage, so with only a blob it
// cannot tell "no signature configured" from "a signature is configured and I
// can't read it". Its options would be to warn on every run — noise that trains
// people to ignore it — or never, which is the silent divergence this repo
// keeps paying for. The plaintext register is what lets it warn EXACTLY when
// there was something it failed to send. `mcp/run-plan.mjs` already makes this
// argument for `secretVariableNames`.
//
// The register holds host, expiry and id. NEVER a header value.
//
// The llm-service failure is answered head-on rather than ignored: this store
// reports THREE states, and `unreadable` is one of them. Collapsing it into
// `none` would rebuild that exact bug — a signature the user registered,
// silently absent, with a settings pane saying nothing is configured.
//
// ── Write order ───────────────────────────────────────────────────────────
// Both writes can fail independently, so the rule is that whichever state
// survives a partial failure has to be the VISIBLE one. Registering writes the
// register first (a row that says "unreadable" is recoverable; a credential
// that is live but listed nowhere is not), and removing writes the blob first,
// for the same reason read the other way round. `signatureFor` then requires
// BOTH halves, so a value stranded in the blob is never sent.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { app, logger } from "@shell/backend";

import {
  headerValueProblem,
  normalizeSignatureHost,
  parseSignatureInput,
  signatureForUrl,
  signatureState,
  validateHeaderValue,
  SIGNATURE_AGENT_VALUE,
} from "../../shared/shopify-signature.mjs";
import type { SignatureState } from "../../shared/shopify-signature.mjs";

import { createEncryptedSecretStore } from "./encrypted-secret-store.js";

/** A registered signature, values included. Backend-only — this shape must
 *  never cross IPC. */
export interface ShopifySignatureEntry {
  id: string;
  host: string;
  signatureInput: string;
  signature: string;
  signatureAgent: string;
  /** Unix SECONDS, read out of `Signature-Input`. Null when it carried none. */
  expiresAt: number | null;
}

/** What the renderer and the MCP are allowed to know. No header value appears
 *  here, which is the plaintext register's whole contract. */
export interface ShopifySignatureStatus {
  id: string;
  host: string;
  /** Unix SECONDS. */
  expiresAt: number | null;
  /** Unix SECONDS, from the header's `created`. */
  createdAt: number | null;
  /** Milliseconds — when the user pasted it, not when Shopify issued it. */
  addedAt: number;
  state: ShopifySignatureStatusState;
}

/** `unreadable` outranks every expiry state: an entry whose values cannot be
 *  decrypted has no usable expiry to report. */
export type ShopifySignatureStatusState = SignatureState | "unreadable";

/** The plaintext register's on-disk shape. */
interface RegisterFile {
  version: number;
  entries: {
    id: string;
    host: string;
    expiresAt: number | null;
    createdAt: number | null;
    addedAt: number;
  }[];
}

/** The encrypted blob's on-disk shape. */
interface SecretFile {
  version: number;
  entries: ShopifySignatureEntry[];
}

const VERSION = 1;

export const SIGNATURE_REGISTER_FILE = "shopify-signatures.json";
export const SIGNATURE_SECRET_FILE = "shopify-signatures.bin";

const secretStore = createEncryptedSecretStore({
  fileName: SIGNATURE_SECRET_FILE,
  label: "Shopify crawler signature",
});

function registerPath(): string {
  return path.join(app.getPath("userData"), "recorder", SIGNATURE_REGISTER_FILE);
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT";
}

/** Read the plaintext register, rebuilding it field by field.
 *
 *  Field by field rather than a spread, for the reason recorder-settings-store
 *  gives: this file is on disk where anything can edit it, and a shape carried
 *  through unchecked is one the rest of the app then trusts. */
async function readRegister(): Promise<RegisterFile["entries"]> {
  let raw: string;
  try {
    raw = await fs.readFile(registerPath(), "utf-8");
  } catch (err) {
    if (!isFileNotFound(err)) {
      logger.warn("secrets", "Failed to read the Shopify signature register", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RegisterFile>;
    if (!parsed || !Array.isArray(parsed.entries)) return [];
    const out: RegisterFile["entries"] = [];
    for (const entry of parsed.entries) {
      const host = typeof entry?.host === "string" ? normalizeSignatureHost(entry.host) : null;
      const id = typeof entry?.id === "string" ? entry.id : null;
      if (!host || !id) continue;
      out.push({
        id,
        host,
        expiresAt: typeof entry.expiresAt === "number" ? entry.expiresAt : null,
        createdAt: typeof entry.createdAt === "number" ? entry.createdAt : null,
        addedAt: typeof entry.addedAt === "number" ? entry.addedAt : 0,
      });
    }
    return out;
  } catch {
    logger.warn("secrets", "The Shopify signature register is not valid JSON; ignoring it");
    return [];
  }
}

async function writeRegister(entries: RegisterFile["entries"]): Promise<void> {
  const target = registerPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const body: RegisterFile = { version: VERSION, entries };
  const tempPath = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(body, null, 2), "utf-8");
    await fs.rename(tempPath, target);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

/** The decrypted entries, or null when the blob is absent or unreadable.
 *
 *  Null and [] are deliberately different answers: an empty list means the blob
 *  decrypted and holds nothing, null means it could not be read at all. Only
 *  the second one produces an `unreadable` row. */
async function readSecrets(): Promise<ShopifySignatureEntry[] | null> {
  const raw = await secretStore.get();
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SecretFile>;
    if (!parsed || !Array.isArray(parsed.entries)) return null;
    return parsed.entries.filter(
      (entry): entry is ShopifySignatureEntry =>
        typeof entry?.id === "string" &&
        typeof entry?.host === "string" &&
        typeof entry?.signatureInput === "string" &&
        typeof entry?.signature === "string" &&
        typeof entry?.signatureAgent === "string",
    );
  } catch {
    logger.warn("secrets", "The Shopify signature blob did not parse; treating it as unreadable");
    return null;
  }
}

async function writeSecrets(entries: ShopifySignatureEntry[]): Promise<void> {
  const body: SecretFile = { version: VERSION, entries };
  await secretStore.set(JSON.stringify(body));
}

/** Why a paste is unacceptable, or null. Every field is checked, and the host
 *  is checked first because it is the one the user is most likely to get
 *  wrong — a signature at the wrong authority is worse than no signature. */
export function signatureInputProblem(input: {
  host: string;
  signatureInput: string;
  signature: string;
  signatureAgent?: string;
}): string | null {
  if (!normalizeSignatureHost(input.host)) {
    return "That doesn't look like a domain. Paste the store domain the signature was created for, for example shop.example.com.";
  }
  const inputProblem = headerValueProblem(input.signatureInput, "Signature-Input");
  if (inputProblem) return inputProblem;
  const valueProblem = headerValueProblem(input.signature, "Signature");
  if (valueProblem) return valueProblem;
  if (input.signatureAgent !== undefined && input.signatureAgent.trim() !== "") {
    const agentProblem = headerValueProblem(input.signatureAgent, "Signature-Agent");
    if (agentProblem) return agentProblem;
  }
  // Refused rather than repaired. A value with no parameters at all is far more
  // likely to be the wrong field pasted into the wrong box than a valid
  // signature, and accepting it would produce a row reading "expiry unknown"
  // that never works and never says why.
  if (!parseSignatureInput(input.signatureInput)) {
    return "That Signature-Input value doesn't look like one Shopify issued. Copy the whole value from the admin, including the part before the first semicolon.";
  }
  return null;
}

export const shopifySignatureStore = {
  /** What is registered, with no header value. Safe to hand to the renderer. */
  async list(nowMs: number = Date.now()): Promise<ShopifySignatureStatus[]> {
    const register = await readRegister();
    if (register.length === 0) return [];
    const secrets = await readSecrets();
    return register.map((entry) => ({
      id: entry.id,
      host: entry.host,
      expiresAt: entry.expiresAt,
      createdAt: entry.createdAt,
      addedAt: entry.addedAt,
      state:
        secrets === null || !secrets.some((s) => s.id === entry.id)
          ? "unreadable"
          : signatureState({ expiresAt: entry.expiresAt, nowMs }),
    }));
  },

  /** Register a signature, replacing any existing one for the same host.
   *
   *  Upsert by HOST, not append: Shopify issues one signature per domain, so a
   *  second entry for a host means two candidates for one request and a silent
   *  first-wins. Throws with a readable message when the paste is unacceptable. */
  async upsert(input: {
    host: string;
    signatureInput: string;
    signature: string;
    signatureAgent?: string;
  }): Promise<ShopifySignatureStatus> {
    const problem = signatureInputProblem(input);
    if (problem) throw new Error(problem);

    const host = normalizeSignatureHost(input.host);
    const signatureInput = validateHeaderValue(input.signatureInput);
    const signature = validateHeaderValue(input.signature);
    // Shopify's admin always shows the same agent value, so an empty box means
    // "the usual one" rather than an error.
    const signatureAgent =
      input.signatureAgent && input.signatureAgent.trim() !== ""
        ? validateHeaderValue(input.signatureAgent)
        : SIGNATURE_AGENT_VALUE;
    if (!host || !signatureInput || !signature || !signatureAgent) {
      throw new Error("That signature could not be read.");
    }

    const parsed = parseSignatureInput(signatureInput);
    const existing = (await readRegister()).filter((entry) => entry.host !== host);
    const id = randomUUID();
    const registerEntry = {
      id,
      host,
      expiresAt: parsed?.expiresAt ?? null,
      createdAt: parsed?.createdAt ?? null,
      addedAt: Date.now(),
    };

    // Register first — see the write-order note at the top of the file.
    await writeRegister([...existing, registerEntry]);
    const secrets = (await readSecrets()) ?? [];
    await writeSecrets([
      ...secrets.filter((entry) => entry.host !== host),
      { id, host, signatureInput, signature, signatureAgent, expiresAt: registerEntry.expiresAt },
    ]);

    logger.info("secrets", "Registered a Shopify crawler signature", {
      host,
      expiresAt: registerEntry.expiresAt,
    });
    return {
      ...registerEntry,
      state: signatureState({ expiresAt: registerEntry.expiresAt, nowMs: Date.now() }),
    };
  },

  /** Forget a signature. Blob first — see the write-order note. */
  async remove(id: string): Promise<void> {
    const secrets = await readSecrets();
    if (secrets !== null) await writeSecrets(secrets.filter((entry) => entry.id !== id));
    const register = await readRegister();
    const remaining = register.filter((entry) => entry.id !== id);
    if (remaining.length === 0) {
      // Remove the files rather than leaving an empty register behind, so
      // "nothing configured" is one state on disk and not two.
      await fs.rm(registerPath(), { force: true });
      await secretStore.clear();
    } else {
      await writeRegister(remaining);
    }
    logger.info("secrets", "Removed a Shopify crawler signature");
  },

  /** Every registered, readable, unexpired signature — values included.
   *
   *  Requires BOTH halves: an entry present in the blob but absent from the
   *  register is never returned, so a failed removal cannot leave a credential
   *  live and invisible. */
  async entries(nowMs: number = Date.now()): Promise<ShopifySignatureEntry[]> {
    const register = await readRegister();
    if (register.length === 0) return [];
    const secrets = await readSecrets();
    if (secrets === null) return [];
    const out: ShopifySignatureEntry[] = [];
    for (const entry of register) {
      const secret = secrets.find((s) => s.id === entry.id);
      if (!secret) continue;
      if (signatureState({ expiresAt: entry.expiresAt, nowMs }) === "expired") continue;
      out.push({ ...secret, host: entry.host, expiresAt: entry.expiresAt });
    }
    return out;
  },

  /** The signature to send with a request to `url`, or null. */
  async signatureFor(
    url: string,
    nowMs: number = Date.now(),
  ): Promise<ShopifySignatureEntry | null> {
    return signatureForUrl(await shopifySignatureStore.entries(nowMs), url, nowMs);
  },

  /** Values that must never appear in a log, an artifact, a webhook payload or
   *  an LLM prompt.
   *
   *  TWO values, not three. `Signature-Agent` is the public literal
   *  `"https://shopify.com"`; putting it in the redaction snapshot would
   *  replace that string everywhere it legitimately appears — in this app's own
   *  documentation text, in a page's content, in an error message — which is
   *  noise at best and corrupted output at worst.
   *
   *  Includes EXPIRED entries, deliberately. An expired signature is no longer
   *  sent, but one that was sent an hour ago is still sitting in yesterday's
   *  run log, and this is what strips it on the way out. */
  /** Test seam — drops the in-process cache so the next read hits disk. */
  resetCache(): void {
    secretStore.resetCache();
  },

  async headerValuesForRedaction(): Promise<string[]> {
    const secrets = await readSecrets();
    if (secrets === null) return [];
    const out: string[] = [];
    for (const entry of secrets) {
      for (const value of [entry.signature, entry.signatureInput]) {
        if (value && !out.includes(value)) out.push(value);
      }
    }
    return out;
  },
};
