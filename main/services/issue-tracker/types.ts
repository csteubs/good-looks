// The backend-only half of the issue-tracker model: the contract a provider
// implements, and the error class it is allowed to throw.
//
// The wire shapes (`ConnectionStatus`, `IssueContainer`, …) live in
// `renderer/lib/issue-types.ts` and are re-exported below, so backend callers
// have one import. They are declared there rather than here for the reason
// `branch-types.ts` gives: a type crossing IPC has two ends, and a mirror is a
// promise someone has to keep.
//
// The interface below is deliberately designed against TWO APIs rather than
// one. An interface derived from a single example becomes that example renamed,
// and then fits the second provider badly — so every decision is the one that
// survives Linear (GraphQL, UUIDs plus a human identifier, labels as node ids,
// team → project, upload-then-reference) AND GitHub Issues (REST,
// repository-scoped integers, labels as plain strings, repo → milestone, asset
// embedded in markdown). Only Linear is implemented; GitHub exists here as the
// adversary that keeps the shape honest. If a future member needs an escape
// hatch through this interface, that is the signal the abstraction was
// premature and Linear should have been built directly.
//
// Four consequences, each traceable to a disagreement between the two:
//
//   • Methods express INTENT, never a query or a route. GraphQL and REST have
//     nothing in common at the transport layer and never will.
//   • Containers are named by the PROVIDER (`ProviderVocabulary`), not by this
//     file. "Team" is Linear's word; a UI hardcoding it is wrong the moment a
//     second provider exists, and the string belongs next to the code that
//     knows the answer.
//   • Containers nest exactly two levels, the second optional. Team → project
//     and repository → milestone are the same shape.
//   • Providers are STATELESS with respect to the credential: the key is passed
//     per call rather than held. The token store already caches and already
//     owns the write-only contract, and a provider holding a decrypted key is a
//     second place it lives for the lifetime of the process.

import type {
  IssueContainer,
  IssueSubContainer,
  ProviderAccount,
  ProviderId,
  ProviderVocabulary,
} from "../../../renderer/lib/issue-types.js";

export type {
  ConnectionStatus,
  IssueContainer,
  IssueDefaults,
  IssueSubContainer,
  ProviderAccount,
  ProviderId,
  ProviderVocabulary,
} from "../../../renderer/lib/issue-types.js";

/**
 * How a provider failed, in terms a caller can branch on.
 *
 * The split that matters is `auth` versus everything else: a rejected key is
 * the user's problem to fix and the UI must say so plainly, while a network or
 * server failure is not their fault and must not read as "your key is wrong".
 */
export type IssueProviderErrorKind = "auth" | "network" | "rate-limit" | "server" | "unknown";

/**
 * An error safe to show a user.
 *
 * `message` is displayed verbatim, which is the whole reason this class exists:
 * it is the one place that guarantees a credential never reaches a toast, a
 * dialog or the log. Provider code constructs these; it never rethrows a raw
 * fetch error, because a thrown `TypeError` from fetch can carry the request
 * URL, and for a provider authenticating by header that is one refactor away
 * from carrying the header too.
 */
export class IssueProviderError extends Error {
  readonly kind: IssueProviderErrorKind;

  constructor(kind: IssueProviderErrorKind, message: string) {
    super(message);
    this.name = "IssueProviderError";
    this.kind = kind;
  }
}

/**
 * What every provider can do.
 *
 * Phase 1 is the read half only — enough to prove a key works and to choose
 * where issues will go. Creating issues, uploading images and commenting arrive
 * with the compose dialog, and are deliberately absent here so this interface
 * cannot be half-implemented and look finished.
 */
export interface IssueProvider {
  readonly id: ProviderId;
  readonly vocabulary: ProviderVocabulary;

  /** Confirm the key is accepted and report whose it is.
   *  @throws {IssueProviderError} */
  verify(key: string): Promise<ProviderAccount>;

  /** Containers the key can file into.
   *  @throws {IssueProviderError} */
  listContainers(key: string): Promise<IssueContainer[]>;

  /** Sub-containers across the workspace. Filtering to a container is the
   *  caller's job, since a provider may not scope them at all.
   *  @throws {IssueProviderError} */
  listSubContainers(key: string): Promise<IssueSubContainer[]>;
}
