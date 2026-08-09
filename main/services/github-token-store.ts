// The GitHub token the branch switcher lists pull requests with — encrypted
// on-device, same mechanism and same write-only contract as the Anthropic key
// and the LM Studio token.
//
// Optional by design. A public repository lists its open PRs unauthenticated,
// and the switcher works with no token at all. A token buys two things: private
// repositories (which answer 404, not 403, so without one the failure reads as
// "no such repository" rather than "you aren't allowed") and the authenticated
// rate limit, which matters because 60 requests an hour is shared with
// everything else on the machine's IP.

import { createEncryptedSecretStore } from "./encrypted-secret-store.js";

const store = createEncryptedSecretStore({
  fileName: "github-token.bin",
  label: "GitHub token",
});

export const githubTokenStore = {
  /** Persist the plaintext token, encrypted. Throws if encryption is unavailable. */
  setToken: (plain: string): Promise<void> => store.set(plain),
  /** Remove the stored token. */
  clear: (): Promise<void> => store.clear(),
  /** Decrypt and return the stored token, or null if none is saved. */
  getToken: (): Promise<string | null> => store.get(),
  /** Whether a token is stored, without decrypting or returning it. */
  hasToken: (): Promise<boolean> => store.has(),
};
