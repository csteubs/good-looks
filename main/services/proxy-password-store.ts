// Stores the manual proxy's password encrypted on-device via safeStorage,
// exactly as anthropic-key-store.ts stores the API key: the renderer hands a
// value in once and only ever reads back WHETHER one exists.
//
// It is the one half of the proxy configuration that is a secret, and the
// split is deliberate: everything else lives in plain recorder-settings.json,
// where the MCP server can read it and apply the same rules to the runs it
// spawns. The password it cannot decrypt — the MCP has no safeStorage — so an
// MCP run through an authenticated proxy goes unauthenticated and says so up
// front, the same contract test secrets set (see mcp/run-plan.mjs).

import { createEncryptedSecretStore } from "./encrypted-secret-store.js";

const store = createEncryptedSecretStore({
  fileName: "proxy-password.bin",
  label: "proxy password",
});

export const proxyPasswordStore = {
  /** Persist the plaintext password, encrypted. Throws if encryption is unavailable. */
  set: (plain: string): Promise<void> => store.set(plain),
  /** Remove the stored password. */
  clear: (): Promise<void> => store.clear(),
  /** Decrypt and return the stored password, or null if none is saved. */
  get: (): Promise<string | null> => store.get(),
  /** Whether a password is stored, without decrypting or returning it. */
  has: (): Promise<boolean> => store.has(),
};
