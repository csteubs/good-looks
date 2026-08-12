// Which providers exist, and where each keeps its key.
//
// One entry today. It is a table rather than a direct import so that adding a
// provider is a row here plus its two files — and so that every caller already
// asks "which provider?" rather than naming Linear, which is the difference
// between adding a second one and rewriting for it.

import type { EncryptedSecretStore } from "../encrypted-secret-store.js";
import { createLinearProvider } from "./linear-provider.js";
import { linearTokenStore } from "./linear-token-store.js";
import type { IssueProvider, ProviderId } from "./types.js";

/** The provider a user is working with. A field rather than a constant at every
 *  call site, so the day there are two, the choice has one home. */
export const ACTIVE_PROVIDER: ProviderId = "linear";

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
};

export function providerFor(id: ProviderId): IssueProvider {
  return REGISTRY[id].provider;
}

export function keyStoreFor(id: ProviderId): Entry["key"] {
  return REGISTRY[id].key;
}
