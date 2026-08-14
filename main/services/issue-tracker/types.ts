// The backend-only half of the issue-tracker model: the contract a provider
// implements, and the error class it is allowed to throw.
//
// The wire shapes (`ConnectionStatus`, `IssueContainer`, …) live in
// `renderer/lib/issue-types.ts` and are re-exported below, so backend callers
// have one import. They are declared there rather than here for the reason
// `branch-types.ts` gives: a type crossing IPC has two ends, and a mirror is a
// promise someone has to keep.
//
// The interface below was designed against TWO APIs rather than one. An
// interface derived from a single example becomes that example renamed, and then
// fits the second provider badly — so every decision is the one that survives
// Linear (GraphQL, UUIDs plus a human identifier, labels as node ids, team →
// project, upload-then-reference) AND GitHub Issues (REST, repository-scoped
// integers, labels as plain strings, repo → milestone, asset embedded in
// markdown). BOTH ARE NOW IMPLEMENTED, and the bet mostly paid: `createIssue`,
// `addComment` and `verify` took GitHub with no change at all.
//
// Two places it did not, both recorded here because they are what the second
// provider actually costs:
//
//   • `listSubContainers` and `listLabels` had no container argument. Linear
//     scopes neither, GitHub scopes both, and no amount of interface taste
//     removes that disagreement — so they take one now. Not an escape hatch: a
//     narrowing hint both providers answer honestly, one by using it and one by
//     ignoring it.
//   • `supportsImageUpload` on the vocabulary. Not every provider can carry the
//     evidence, and the dialog has to say so before the send rather than after.
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
  CreatedIssue,
  IssueContainer,
  IssueLabel,
  IssueSubContainer,
  ProviderAccount,
  ProviderId,
  ProviderVocabulary,
} from "../../../renderer/lib/issue-types.js";

export type {
  ConnectionStatus,
  ProviderChoice,
  CreatedIssue,
  DefectSource,
  DraftAttachment,
  IssueContainer,
  IssueDefaults,
  IssueDestination,
  IssueDraft,
  IssueLabel,
  IssueSubContainer,
  ProviderAccount,
  ProviderId,
  ProviderVocabulary,
} from "../../../renderer/lib/issue-types.js";

/** One image to upload, read from disk by the backend at send time. */
export interface UploadImage {
  /** Shown as the image's caption in the issue. */
  label: string;
  /** Filename the provider should store it under. */
  filename: string;
  bytes: Buffer;
  contentType: string;
}

/** Everything needed to file one issue, after the user has edited it. */
export interface CreateIssueRequest {
  title: string;
  /** Markdown. Whatever the user finally approved. */
  body: string;
  containerId: string;
  subContainerId: string | null;
  labelIds: string[];
  images: UploadImage[];
}

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
 * Every method is required. There is no optional member and no capability
 * negotiation through this interface, deliberately: a provider that cannot do
 * one of these is a provider whose issues would silently be worse, and the one
 * real asymmetry found so far — GitHub cannot upload images — is declared on the
 * vocabulary where the UI can read it BEFORE sending, rather than discovered
 * here by a method that quietly does less.
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

  /**
   * Sub-containers, optionally narrowed to one container.
   *
   * `containerId` is a HINT, not a filter the caller can rely on: Linear
   * answers workspace-wide and attributes each project to a team, so the UI
   * still filters. GitHub cannot answer at all without it — a milestone lives
   * in a repository and there is no cross-repository milestone list — so it
   * returns nothing when none is named. That disagreement is the reason the
   * parameter exists rather than the caller passing everything through a
   * workspace-shaped call that GitHub would have to fake.
   *
   * @throws {IssueProviderError}
   */
  listSubContainers(key: string, containerId: string | null): Promise<IssueSubContainer[]>;

  /** Labels the user can pick, by NAME. Resolving names to whatever the
   *  provider actually wants — node ids for Linear, plain strings for GitHub —
   *  is the provider's job, not a caller's. `containerId` is scoped the same way
   *  as `listSubContainers`: GitHub's labels are per-repository, Linear's are
   *  workspace-wide and ignore it.
   *  @throws {IssueProviderError} */
  listLabels(key: string, containerId: string | null): Promise<IssueLabel[]>;

  /**
   * File one issue, uploading its images first.
   *
   * Images are handed over as bytes rather than paths: a provider must not
   * read the filesystem, both because `main/shell` owns that boundary and
   * because it keeps every provider testable with no disk at all. How an image
   * reaches the body is the provider's business — Linear uploads to a signed
   * URL and references the asset, GitHub embeds it in markdown — which is why
   * this takes images rather than a body that already mentions them.
   *
   * @throws {IssueProviderError}
   */
  createIssue(key: string, request: CreateIssueRequest): Promise<CreatedIssue>;

  /** Append a comment to an existing issue — how a recurrence is reported
   *  instead of filing a duplicate.
   *  @throws {IssueProviderError} */
  addComment(key: string, issueId: string, body: string, images: UploadImage[]): Promise<void>;
}
