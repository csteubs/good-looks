// Which providers exist, and where each keeps its key.
//
// A table rather than a set of direct imports, so that adding a provider is a
// row here plus its two files — and so that every caller already asks "which
// provider?" rather than naming one. That shape is what made adding GitHub an
// addition instead of a rewrite.
//
// THIS FILE OWNS THE RUNTIME LIST. `renderer/lib/issue-types.ts` declares the
// union type but deliberately holds no array: it is imported type-only by the
// main process, and a `const` there would be the first runtime import to cross
// that boundary. Anything needing to enumerate providers — the IPC handler
// behind the settings picker, the validator below — comes here.

import type { EncryptedSecretStore } from "../encrypted-secret-store.js";
import { createGithubProvider } from "./github-provider.js";
import { githubIssueTokenStore } from "./github-issue-token-store.js";
import { createLinearProvider } from "./linear-provider.js";
import { linearTokenStore } from "./linear-token-store.js";
import type { IssueProvider, ProviderId } from "./types.js";

/**
 * The provider used when nothing has been chosen yet.
 *
 * Only a fallback now — the choice lives in `issue-config-store` and is made in
 * Settings → Integrations. It stays Linear so that an existing install, which
 * has a Linear key and no stored preference, keeps working exactly as it did.
 */
export const DEFAULT_PROVIDER: ProviderId = "linear";

interface Entry {
  provider: IssueProvider;
  /** The credential this provider authenticates with. Typed as the shared
   *  store interface so a provider cannot invent its own storage. */
  key: Pick<EncryptedSecretStore, "get" | "set" | "clear" | "has">;
}

const REGISTRY: Record<ProviderId, Entry> = {
  linear: {
    provider: createLinearProvider(),
    key: {
      get: () => linearTokenStore.getKey(),
      set: (plain: string) => linearTokenStore.setKey(plain),
      clear: () => linearTokenStore.clear(),
      has: () => linearTokenStore.hasKey(),
    },
  },
  github: {
    provider: createGithubProvider(),
    key: {
      // NOT `githubTokenStore` — that one is the branch switcher's, and
      // `disconnect()` clears whatever it is pointed at. See the header of
      // `github-issue-token-store.ts`.
      get: () => githubIssueTokenStore.getKey(),
      set: (plain: string) => githubIssueTokenStore.setKey(plain),
      clear: () => githubIssueTokenStore.clear(),
      has: () => githubIssueTokenStore.hasKey(),
    },
  },
};

/** Every implemented provider, in the order the settings picker offers them. */
export const PROVIDER_IDS = Object.keys(REGISTRY) as ProviderId[];

/**
 * Whether a value naming a provider is one.
 *
 * The guard on the IPC boundary and on everything read back off disk. A
 * `ProviderId` indexes `REGISTRY` directly, so an unchecked string reaching
 * `providerFor` is an undefined dereference — and it arrives from two places
 * that are not this process: the renderer, and a JSON file a user can edit.
 */
export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(REGISTRY, v);
}

export function providerFor(id: ProviderId): IssueProvider {
  return REGISTRY[id].provider;
}

export function keyStoreFor(id: ProviderId): Entry["key"] {
  return REGISTRY[id].key;
}
