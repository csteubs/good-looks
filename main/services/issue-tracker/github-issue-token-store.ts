// The GitHub token issues are filed with — encrypted on-device, same mechanism
// and same write-only contract as the Linear key.
//
// SEPARATE FROM `github-token-store.ts`, which is the branch switcher's, and
// the separation is load-bearing rather than tidiness. Two independent reasons,
// either one sufficient:
//
//   • `disconnect()` CLEARS THE PROVIDER'S KEY. That is the contract every
//     provider is held to, and it is right — disconnecting has to actually
//     disconnect. Point it at the shared token and disconnecting the issue
//     tracker silently stops the branch switcher listing pull requests, in a
//     different window, with nothing on screen connecting the two.
//   • THE SCOPES DIFFER. Listing pull requests needs read access and works
//     unauthenticated on a public repository; filing an issue needs `issues:write`
//     on a repository the user can write to. Sharing one token means the branch
//     switcher's optional, low-privilege credential quietly becomes a
//     write-capable one, which is the wrong direction for a token to drift.
//
// The cost is a user pasting two tokens if they want both features. That is
// visible and explainable; the alternative failure is neither.

import { createEncryptedSecretStore } from "../encrypted-secret-store.js";

const store = createEncryptedSecretStore({
  fileName: "github-issues-key.bin",
  label: "GitHub issues token",
});

export const githubIssueTokenStore = {
  /** Persist the plaintext token, encrypted. Throws if encryption is unavailable. */
  setKey: (plain: string): Promise<void> => store.set(plain),
  /** Remove the stored token. */
  clear: (): Promise<void> => store.clear(),
  /** Decrypt and return the stored token, or null if none is saved. */
  getKey: (): Promise<string | null> => store.get(),
  /** Whether a token is stored, without decrypting or returning it. */
  hasKey: (): Promise<boolean> => store.has(),
};
