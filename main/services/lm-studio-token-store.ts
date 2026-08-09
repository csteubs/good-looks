// Stores LM Studio's API token encrypted on-device, same mechanism and same
// write-only contract as the Anthropic key.
//
// LM Studio's local server can be configured to require a bearer token
// (Developer → server settings). With it on, EVERY request 401s — including
// GET /v1/models, which is what this app probes to decide "connected". The
// server's own log is no help there: it prints "Unexpected endpoint or method.
// (GET /v1/models). Returning 200 anyway" for the rejected request, which reads
// like a wrong URL rather than a missing credential. So the token is worth
// storing even though the server is on loopback: without it the provider is
// simply unusable, and the failure does not look like what it is.

import { createEncryptedSecretStore } from "./encrypted-secret-store.js";

const store = createEncryptedSecretStore({
  fileName: "lmstudio-token.bin",
  label: "LM Studio API token",
});

export const lmStudioTokenStore = {
  /** Persist the plaintext token, encrypted. Throws if encryption is unavailable. */
  setToken: (plain: string): Promise<void> => store.set(plain),
  /** Remove the stored token. */
  clear: (): Promise<void> => store.clear(),
  /** Decrypt and return the stored token, or null if none is saved. */
  getToken: (): Promise<string | null> => store.get(),
  /** Whether a token is stored, without decrypting or returning it. */
  hasToken: (): Promise<boolean> => store.has(),
};
