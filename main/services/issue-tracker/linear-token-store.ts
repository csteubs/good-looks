// The Linear personal API key — encrypted on-device, same mechanism and same
// write-only contract as the Anthropic key, the LM Studio token and the GitHub
// token.
//
// One key means one workspace, which is the decision rather than a limitation
// of the storage: a keyed collection is what a second workspace would need, and
// nothing here forecloses it — the file name is provider-specific, so a second
// provider is a second store rather than a migration of this one.

import { createEncryptedSecretStore } from "../encrypted-secret-store.js";

const store = createEncryptedSecretStore({
  fileName: "linear-key.bin",
  label: "Linear API key",
});

export const linearTokenStore = {
  /** Persist the plaintext key, encrypted. Throws if encryption is unavailable. */
  setKey: (plain: string): Promise<void> => store.set(plain),
  /** Remove the stored key. */
  clear: (): Promise<void> => store.clear(),
  /** Decrypt and return the stored key, or null if none is saved. */
  getKey: (): Promise<string | null> => store.get(),
  /** Whether a key is stored, without decrypting or returning it. */
  hasKey: (): Promise<boolean> => store.has(),
};
