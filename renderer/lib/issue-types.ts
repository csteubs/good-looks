// What the issue-tracker integration sends over IPC.
//
// Declared ONCE here and imported type-only by the main-process side, the way
// `branch-types.ts` is rather than the way `recorder-types.ts` mirrors the
// recorder model. `import type` erases at build time, so no runtime import
// crosses the boundary in either direction.
//
// The backend-only half of the model — the `IssueProvider` interface and the
// `IssueProviderError` class — stays in `main/services/issue-tracker/types.ts`,
// because one is a contract no renderer implements and the other is runtime
// code that would drag a class into the renderer bundle for nothing.
//
// These shapes are deliberately designed against TWO trackers, not one; the
// reasoning for each is in the backend types file, next to the interface that
// forced it.

/**
 * The implemented providers.
 *
 * The runtime list deliberately does NOT live here. This file is imported
 * type-only by the main process (see the note above), and a `const` array would
 * be the first runtime import to cross that boundary. `provider-registry.ts`
 * owns the list, and the renderer learns it over IPC — which is also what stops
 * a pane from hardcoding a product name next to an id.
 */
export type ProviderId = "linear" | "github";

/** Who a stored key belongs to. Shown so a user can tell at a glance that they
 *  pasted the key they meant to. */
export interface ProviderAccount {
  accountName: string;
  /** The workspace the key is scoped to. One per key, by decision. */
  workspaceName: string | null;
}

/** A place an issue can be filed: a Linear team, a GitHub repository. */
export interface IssueContainer {
  id: string;
  name: string;
  /** The provider's own short display form ("ENG"), when it has one. */
  key: string | null;
}

/** The optional second level: a Linear project, a GitHub milestone. */
export interface IssueSubContainer {
  id: string;
  name: string;
  /** Null when the provider doesn't scope it to exactly one container. */
  containerId: string | null;
}

/** The words a provider uses for its own concepts, so the UI can label itself
 *  without hardcoding a product's vocabulary. */
export interface ProviderVocabulary {
  name: string;
  container: string;
  /**
   * The plural of `container`, because English does not have a rule a caller
   * can apply. The pane used to append an "s", which was invisibly fine while
   * Linear was the only provider and produced "3 repositorys" the moment GitHub
   * existed. Naming the container is already the provider's job — see the note
   * on `ProviderVocabulary` in the backend types — and this is the same job.
   */
  containerPlural: string;
  subContainer: string;
  keyHelpUrl: string;
  keyPlaceholder: string;
  /**
   * Whether `createIssue` can carry the screenshots with it.
   *
   * False for GitHub, and it is a capability rather than a detail because the
   * dialog has to SAY SO BEFORE the send. GitHub's attachment upload is a
   * browser-only endpoint with no public API counterpart, so a visual-difference
   * issue filed there arrives as prose about pictures nobody can see. Silently
   * dropping them would be the worst outcome available: the issue looks
   * complete, and the person who files it never learns otherwise.
   */
  supportsImageUpload: boolean;
}

/**
 * One row in the provider picker.
 *
 * Carries the vocabulary rather than just a name so the pane can render the
 * whole choice — label, placeholder, help URL — without a second round trip per
 * option, and without a table of product names living in the renderer.
 */
export interface ProviderChoice {
  id: ProviderId;
  vocabulary: ProviderVocabulary;
  /** Whether a key is already stored for it. Lets the picker show which
   *  providers are ready without verifying — a local, cheap claim, the same
   *  distinction `ConnectionStatus` draws between `hasKey` and `account`. */
  hasKey: boolean;
}

/**
 * Everything the renderer is allowed to know about the connection.
 *
 * `hasKey` and `account` are separate claims on purpose: a key is stored, and
 * the key works. Collapsing them means either a working key reads as broken
 * while offline, or a revoked key keeps reporting Connected.
 */
export interface ConnectionStatus {
  provider: ProviderId;
  hasKey: boolean;
  /** Non-null once a verification has succeeded this session. */
  account: ProviderAccount | null;
  /** Why the last verification failed. Never contains the key. */
  error: string | null;
}

/** Where issues go by default. */
export interface IssueDefaults {
  containerId: string | null;
  subContainerId: string | null;
}

/** A label, by the name a user reads. Ids are resolved by the provider — Linear
 *  wants node ids, GitHub takes plain strings, and a caller should not have to
 *  know which. */
export interface IssueLabel {
  id: string;
  name: string;
  /** Provider-supplied swatch, when it has one. Shown, never interpreted. */
  color: string | null;
}

/**
 * WHICH defect is being filed — never the defect's content.
 *
 * The renderer names a coordinate (this test, this run, this step) and the
 * BACKEND loads the evidence from disk itself. That is deliberate: the evidence
 * is screenshots, console lines and error text, and a renderer that carried it
 * across IPC to hand back for sending would make the leak check meaningless —
 * it could only verify what it was given. This way `buildIssueDraft` is the one
 * place the outgoing shape is decided, and `check:issue-payload` can assert
 * against it directly.
 */
export type DefectSource =
  | {
      kind: "a11y";
      testId: string;
      runId: string;
      stepId: string;
      /** axe rule id, e.g. "color-contrast". Identifies one violation on the step. */
      ruleId: string;
    }
  | { kind: "visual"; testId: string; runId: string; stepId: string }
  | { kind: "failure"; testId: string; runId: string; stepId: string | null }
  /** An AI insights report, filed whole. Not a defect, but it rides the same
   *  pipeline for the same reason the pipeline exists: the renderer names a
   *  coordinate and the BACKEND assembles what is sent — here from the stored
   *  report, which was already summary-shaped and redacted at generation. */
  | { kind: "insight-report"; reportId: string };

/** An image that will be attached, described for the confirmation strip. The
 *  renderer renders these BEFORE the send, because a screenshot cannot be
 *  redacted and consent is the only real mitigation. */
export interface DraftAttachment {
  /** "Baseline" / "This run" / "Difference" — what the reader is looking at. */
  label: string;
  /** How the backend re-reads this image at send time: a run-relative filename,
   *  or `baseline:<stepId>` for a pinned baseline. The renderer never sends
   *  image bytes back — it names the same coordinate, so what is uploaded
   *  cannot be substituted by anything that happened in between. */
  file: string;
  /** Data URL for the confirmation strip. Preview only. */
  previewUrl: string;
  bytes: number;
}

/**
 * The pre-filled issue, before the user edits it.
 *
 * `title` and `body` are editable and whatever the user finally sends is their
 * own text. What the leak check guarantees is this DEFAULT: that nothing
 * arrived here the user would not expect to be sending.
 */
export interface IssueDraft {
  source: DefectSource;
  title: string;
  /** Markdown. */
  body: string;
  attachments: DraftAttachment[];
  /** Warnings the dialog must show — e.g. a run recorded with header filtering
   *  off, whose network entries are therefore withheld. Plain sentences. */
  notices: string[];
}

/** Where one issue is being filed, as chosen in the dialog. */
export interface IssueDestination {
  containerId: string;
  subContainerId: string | null;
  labelIds: string[];
}

/** A filed issue. `identifier` is the display form ("ENG-42"); `id` is opaque. */
export interface CreatedIssue {
  id: string;
  identifier: string;
  url: string;
}

/**
 * A defect that already has an issue.
 *
 * Keyed WITHOUT a run id, which is the whole point: a visual difference or an
 * accessibility violation reappears on every run, so a run-keyed link would
 * report "not yet filed" every time and the feature would produce one duplicate
 * per run. `stepId` is stable across runs — it is what annotations are pinned
 * to — so a link made today is still found tomorrow.
 */
export interface IssueLink {
  provider: ProviderId;
  testId: string;
  stepId: string;
  /** The run it was filed from. Part of the key ONLY for a failure that blamed
   *  no step, where nothing else identifies the defect. */
  runId: string;
  kind: DefectSource["kind"];
  /** The axe rule for an a11y link; empty for kinds with one defect per step. */
  ruleId: string;
  issueId: string;
  identifier: string;
  url: string;
  createdAt: number;
  /** Last time a recurrence was reported onto this issue. */
  lastCommentedAt?: number;
}
