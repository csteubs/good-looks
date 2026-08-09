// Stores the user's Anthropic API key encrypted on-device via safeStorage.
// The key never leaves the backend: the renderer sends it once when saving,
// and only ever reads back whether a key is present (see llm:hasApiKey).
//
// The mechanism lives in encrypted-secret-store.ts, shared with LM Studio's API
// token. The method names here are kept (setKey/getKey/hasKey) because every
// call site and test stub addresses them.

import { createEncryptedSecretStore } from "./encrypted-secret-store.js";

const store = createEncryptedSecretStore({
  fileName: "anthropic-key.bin",
  label: "Anthropic API key",
});

export const anthropicKeyStore = {
  /** Persist the plaintext key, encrypted. Throws if encryption is unavailable. */
  setKey: (plain: string): Promise<void> => store.set(plain),
  /** Remove the stored key. */
  clear: (): Promise<void> => store.clear(),
  /** Decrypt and return the stored key, or null if none is saved. */
  getKey: (): Promise<string | null> => store.get(),
  /** Whether a key is stored, without decrypting or returning it. */
  hasKey: (): Promise<boolean> => store.has(),
};
