// The dialog that files a defect.
//
// One dialog for all three touchpoints. What differs between an accessibility
// violation, a visual difference and a failed step is the DRAFT, which the
// backend assembles from disk — so this component knows nothing about defects
// and everything about consent.
//
// THE THUMBNAIL STRIP IS THE SECURITY FEATURE. A screenshot of a page under
// test can contain anything the page rendered or the user typed, and unlike
// text it cannot be redacted. So the mitigation is not filtering, it is making
// the images impossible to send without having seen them: they are shown at a
// size you can actually read, above the button, each one removable. You cannot
// promise the picture is clean; you can guarantee the person saw it.
//
// FAILURES ARE LOUD AND THE DIALOG STAYS OPEN, which is the opposite of
// `alert-service`'s swallow-everything rule — and correctly so. That rule
// exists because the webhook fires unattended mid-run. This fires because
// someone pressed a button and is waiting, and closing over a long typed
// description on a transient network blip is how you lose it.

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Dialog, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Text, Textarea } from "@ui";
import { AlertTriangle, X } from "lucide-react";

import { api } from "../lib/api";
import type {
  CreatedIssue,
  DefectSource,
  IssueContainer,
  IssueDraft,
  IssueLabel,
  IssueLink,
  IssueSubContainer,
  ProviderVocabulary,
} from "../lib/issue-types";

const NONE = "__none__";

/**
 * The link already filed for this exact defect, if any.
 *
 * Mirrors `issue-link-store`'s key, minus the run — deliberately, because that
 * is what makes a link survive from one run to the next. Matching here rather
 * than asking the backend per defect keeps it to one read for a whole list.
 */
function matchingLink(links: IssueLink[], source: DefectSource): IssueLink | null {
  // A report link stores its report id where a step id goes — the same slot
  // mapping `linkKey` uses, so this read matches what that write produced.
  const stepId =
    source.kind === "insight-report"
      ? source.reportId
      : source.kind === "failure"
        ? (source.stepId ?? "")
        : source.stepId;
  const ruleId = source.kind === "a11y" ? source.ruleId : "";
  return (
    links.find(
      (l) => l.kind === source.kind && l.stepId === stepId && l.ruleId === ruleId,
    ) ?? null
  );
}

/**
 * WHICH defect this is, as a string — what the load effect below depends on.
 *
 * FOUR OF THE FIVE call sites build `source` as an object literal during render
 * — `test-detail-view`, `visual-view`, `a11y-panel` and `insights-view`; only
 * `a11y-view` passes a value it captured into state when the user clicked. So
 * for those four the identity changes on every parent re-render even when every
 * field is identical, and they re-render whenever a run finishes:
 * `invalidateRunDerived` touches queries they read, and the load effect BLANKS
 * THE FORM before re-fetching. Keyed on the object, a Routine running in the
 * background wiped a half-typed report every few seconds (#121).
 *
 * THE ONE RESIDUE THIS COULD NOT FIX ALONE IS CLOSED, in `a11y-panel`.
 * It derived its `runId` from the LATEST a11y run of the test, so a new run
 * changed this dialog's key for real rather than by identity — and the panel
 * then unmounted the dialog behind its own `Loading…` gate while the replay
 * query refetched on the new key, losing the form before the key was ever
 * consulted. It now captures the anchor run when the user clicks (as
 * `a11y-view` always has) and keeps the previous run's replay while the new one
 * loads. Both halves were needed; see DECISIONS 2026-08-25.
 *
 * Fixed here rather than by memoizing the three callers: a caller that forgets
 * to memoize is invisible — the form still works, it just quietly resets — and
 * the next call site added would forget again.
 *
 * The switch is exhaustive on purpose. A new `DefectSource` kind whose
 * identifying field went unspelled here would key two different defects the
 * same, and the dialog would render the first one's draft while filing the
 * second; the `never` makes that a type error instead. `scope` is part of the
 * identity for the same reason — the same anchor occurrence builds a different
 * draft when the send is widened to the whole rule.
 */
export function defectSourceKey(source: DefectSource): string {
  switch (source.kind) {
    case "a11y":
      return [
        "a11y",
        source.testId,
        source.runId,
        source.stepId,
        source.ruleId,
        source.scope ?? "",
      ].join("|");
    case "visual":
      return ["visual", source.testId, source.runId, source.stepId].join("|");
    case "failure":
      return ["failure", source.testId, source.runId, source.stepId ?? ""].join("|");
    case "insight-report":
      return ["insight-report", source.reportId].join("|");
    default: {
      const unreached: never = source;
      return String(unreached);
    }
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface IssueComposeDialogProps {
  /** Which defect. Null closes the dialog — the caller owns "which one". */
  source: DefectSource | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Told what landed, so the caller can record the link and update its row. */
  onFiled?: (issue: CreatedIssue, source: DefectSource) => void;
  /** Told when a recurrence was reported onto an existing issue instead. */
  onCommented?: (link: IssueLink, source: DefectSource) => void;
}

export function IssueComposeDialog({
  source,
  open,
  onOpenChange,
  onFiled,
  onCommented,
}: IssueComposeDialogProps) {
  const [draft, setDraft] = useState<IssueDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [keptFiles, setKeptFiles] = useState<string[]>([]);

  const [vocab, setVocab] = useState<ProviderVocabulary | null>(null);
  const [containers, setContainers] = useState<IssueContainer[]>([]);
  const [subContainers, setSubContainers] = useState<IssueSubContainer[]>([]);
  const [labels, setLabels] = useState<IssueLabel[]>([]);
  const [containerId, setContainerId] = useState<string>("");
  const [subContainerId, setSubContainerId] = useState<string | null>(null);
  const [labelIds, setLabelIds] = useState<string[]>([]);

  /** Which container the sub-container and label lists were fetched against.
   *  Declared here rather than beside the effect that uses it so the load
   *  effect below can claim the first fetch and stop it happening twice. */
  const loadedFor = useRef<string | null>(null);

  /** Non-null when this defect already has an issue — the dialog then offers a
   *  comment instead of a second issue. */
  const [existing, setExisting] = useState<IssueLink | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  /** The defect's identity, not its object identity — see `defectSourceKey`. */
  const sourceKey = source ? defectSourceKey(source) : null;
  /** Read inside the effect through a ref so it can depend on the KEY without
   *  depending on the caller's object. Assigned during render, which is safe
   *  here for the reason it usually is not: nothing reads it during render,
   *  only the effect below — which runs after the commit that wrote it. */
  const sourceRef = useRef(source);
  sourceRef.current = source;

  // Everything the dialog needs, in one pass when it opens. Reset first so a
  // second defect never renders against the previous one's draft — the failure
  // there is silent and it files the wrong thing.
  useEffect(() => {
    const source = sourceRef.current;
    if (!open || !source) return;
    let cancelled = false;
    setDraft(null);
    setExisting(null);
    setLoadError(null);
    setSendError(null);
    setLoading(true);

    (async () => {
      try {
        const [built, vocabulary, defaults, links] = await Promise.all([
          api.issues.buildDraft(source),
          api.issues.vocabulary().catch(() => null),
          api.issues.getDefaults().catch(() => ({ containerId: null, subContainerId: null })),
          api.issues
            // Report links store an empty testId — the query still returns
            // them, and matchingLink narrows to the one report.
            .linksForTest(source.kind === "insight-report" ? "" : source.testId)
            .catch(() => [] as IssueLink[]),
        ]);
        if (cancelled) return;
        // Checked BEFORE anything else is rendered. The same defect reappears on
        // every run, and a dialog that opened straight onto a create form would
        // produce one duplicate issue per run — which is how this feature
        // becomes the one everyone mutes.
        setExisting(matchingLink(links, source));
        if (!built) {
          // The run was pruned, or the step was re-recorded. Saying so beats
          // opening onto an empty form the user would fill in for nothing.
          setLoadError(
            "This defect's evidence is no longer on disk — the run may have been cleaned up since.",
          );
          return;
        }
        setDraft(built);
        setTitle(built.title);
        setBody(built.body);
        setKeptFiles(built.attachments.map((a) => a.file));
        setVocab(vocabulary);
        setContainerId(defaults.containerId ?? "");
        setSubContainerId(defaults.subContainerId ?? null);

        // Destinations are best-effort: a failure here leaves the pickers empty
        // and the send disabled, which the empty destination already says.
        //
        // The sub-container and label lists are scoped to the container, which
        // for GitHub is the only way to ask for them at all — so they are
        // fetched against the DEFAULT here, and re-fetched by the effect below
        // whenever the user picks a different one.
        const [teams, projects, allLabels] = await Promise.all([
          api.issues.listContainers().catch(() => []),
          api.issues.listSubContainers(defaults.containerId).catch(() => []),
          api.issues.listLabels(defaults.containerId).catch(() => []),
        ]);
        if (cancelled) return;
        loadedFor.current = defaults.containerId ?? "";
        setContainers(teams);
        setSubContainers(projects);
        setLabels(allLabels);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Could not prepare this issue.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // KEYED ON THE STRING, NEVER ON `source` — see `defectSourceKey`. The
    // effect's first act is to blank the form, so an identity-keyed dep made
    // every background run destroy whatever was typed.
  }, [open, sourceKey]);

  /**
   * Re-fetch what the chosen container scopes.
   *
   * Linear answers workspace-wide and this changes nothing for it. GitHub's
   * milestones and labels live inside one repository, so without this the
   * pickers would keep the previous repository's rows — offering a milestone
   * that the repository being filed into does not have, which fails at send
   * time after the report is written.
   *
   * Skips the first pass: the load effect above already fetched against the
   * default, and repeating it here would double every open.
   */
  useEffect(() => {
    if (!open || !draft) return;
    if (loadedFor.current === containerId) return;
    loadedFor.current = containerId;
    let cancelled = false;
    (async () => {
      const scope = containerId || null;
      const [projects, allLabels] = await Promise.all([
        api.issues.listSubContainers(scope).catch(() => []),
        api.issues.listLabels(scope).catch(() => []),
      ]);
      if (cancelled) return;
      setSubContainers(projects);
      setLabels(allLabels);
      // Anything the new container does not offer is dropped rather than left
      // selected-but-invisible: a label id that survives the switch would be
      // sent with the issue while nothing on screen shows it chosen.
      const names = new Set(allLabels.map((l) => l.id));
      setLabelIds((prev) => prev.filter((id) => names.has(id)));
      setSubContainerId((prev) => (prev && projects.some((p) => p.id === prev) ? prev : null));
    })();
    return () => {
      cancelled = true;
    };
  }, [open, draft, containerId]);

  // Reset when the dialog closes, so the next open re-fetches rather than
  // trusting a scope that belonged to the previous defect.
  useEffect(() => {
    if (!open) loadedFor.current = null;
  }, [open]);

  const containerName = vocab?.container ?? "Team";
  const subContainerName = vocab?.subContainer ?? "Project";
  const providerName = vocab?.name ?? "Linear";
  /** Defaults to "uploads work" while the vocabulary is still loading: the
   *  warning is about a specific provider, and flashing it at every dialog for
   *  the fraction of a second before the answer arrives would train people to
   *  ignore it on the one provider it is true for. */
  const noUploads = vocab ? !vocab.supportsImageUpload : false;

  const projectsForTeam = useMemo(
    () => subContainers.filter((p) => p.containerId === null || p.containerId === containerId),
    [subContainers, containerId],
  );

  const kept = useMemo(
    () => (draft?.attachments ?? []).filter((a) => keptFiles.includes(a.file)),
    [draft, keptFiles],
  );

  /** Report a recurrence onto the issue that already exists. Same loud-failure
   *  contract as `onSend` — the dialog stays open with the reason on it. */
  const onComment = async () => {
    if (!source || !existing) return;
    setSending(true);
    setSendError(null);
    try {
      await api.issues.commentRecurrence(source, keptFiles);
      onCommented?.(existing, source);
      onOpenChange(false);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const onSend = async () => {
    if (!source || !containerId) return;
    setSending(true);
    setSendError(null);
    try {
      const issue = await api.issues.createIssue({
        source,
        title,
        body,
        attachmentFiles: keptFiles,
        containerId,
        subContainerId,
        labelIds,
      });
      onFiled?.(issue, source);
      onOpenChange(false);
    } catch (err) {
      // Kept on screen, with the typed text intact. See the note at the top.
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Send to ${providerName}`}
      description={
        loadError
          ? undefined
          : existing
            ? `This defect already has an issue in ${providerName}.`
            : `You're about to create an issue in ${providerName}. Everything below is what will be sent.`
      }
      confirmLabel={
        sending ? "Sending…" : existing ? `Comment on ${existing.identifier}` : "Create issue"
      }
      confirmDisabled={
        sending || loading || !draft || (!existing && (!containerId || !title.trim()))
      }
      onConfirm={existing ? onComment : onSend}
      // `2xl` (max-w-4xl), not `large` — `large` is max-w-lg, and at 512px the
      // three-image consent strip wraps to one per row and the description
      // textarea becomes unreadable. The strip has to be legible for the
      // consent it exists to obtain to mean anything.
      size="2xl"
    >
      {loadError ? (
        <Text variant="small" color="secondary">
          {loadError}
        </Text>
      ) : loading || !draft ? (
        <Text variant="small" color="secondary">
          Preparing…
        </Text>
      ) : existing ? (
        // Already filed. The create form is not offered at all rather than
        // offered-and-discouraged: this defect recurs on every run, and one
        // issue accumulating comments is the useful record. Opening the issue
        // is the other honest action, so both are here and neither is hidden.
        <div className="flex flex-col gap-3">
          <Text variant="small">
            This was already filed as <strong>{existing.identifier}</strong>
            {existing.lastCommentedAt
              ? ", and has been seen again since."
              : "."}
          </Text>
          <Text variant="small" color="secondary">
            Adding a comment keeps the history on one issue with this run&apos;s evidence, instead
            of filing a second issue for the same defect.
          </Text>
          {kept.length > 0 ? (
            <Text variant="small" color="tertiary">
              {noUploads
                ? `${providerName} cannot attach images through its API, so the comment will name these ${kept.length} screenshot${kept.length === 1 ? "" : "s"} without carrying them.`
                : `${kept.length} screenshot${kept.length === 1 ? "" : "s"} from this run will go with it.`}
            </Text>
          ) : null}
          {sendError ? (
            <div className="flex items-start gap-2 rounded-md border border-separator p-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <Text variant="small">{sendError}</Text>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {draft.notices.map((n, i) => (
            <div key={i} className="flex items-start gap-2 rounded-md border border-separator p-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <Text variant="small" color="secondary">
                {n}
              </Text>
            </div>
          ))}

          <label className="flex flex-col gap-1">
            <Text variant="small">Title</Text>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={sending} />
          </label>

          <label className="flex flex-col gap-1">
            <Text variant="small">Description</Text>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              className="font-mono text-xs"
              disabled={sending}
            />
          </label>

          {draft.attachments.length > 0 ? (
            <div className="flex flex-col gap-2">
              <Text variant="small">
                {kept.length === 0
                  ? "No screenshots will be attached."
                  : noUploads
                    ? `${kept.length} screenshot${kept.length === 1 ? "" : "s"} will NOT be attached`
                    : `${kept.length} screenshot${kept.length === 1 ? "" : "s"} will be attached`}
              </Text>
              {/* Said BEFORE the send, next to the pictures it is about, rather
                  than discovered afterwards in an issue that looks complete.
                  It sits inside the attachment block so it cannot be read as a
                  general warning about the whole dialog. */}
              {noUploads && kept.length > 0 ? (
                <div className="flex items-start gap-2 rounded-md border border-separator p-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <Text variant="small" color="secondary">
                    {providerName} has no image upload in its API, so these stay on this Mac. The
                    issue will name them so nobody reads it as complete, and you can drag them on by
                    hand afterwards.
                  </Text>
                </div>
              ) : null}
              {/* The consent strip. Large enough to actually read — a 40px
                  thumbnail is a checkbox with a picture on it, and "you saw it"
                  stops being true. */}
              <div className="flex flex-wrap gap-3">
                {draft.attachments.map((a) => {
                  const on = keptFiles.includes(a.file);
                  return (
                    <div
                      key={a.file}
                      className={`flex w-48 flex-col gap-1 rounded-md border p-2 ${
                        on ? "border-separator" : "border-separator opacity-40"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Badge color="secondary">{a.label}</Badge>
                        <Button
                          variant="muted"
                          aria-label={on ? `Remove ${a.label}` : `Include ${a.label}`}
                          onClick={() =>
                            setKeptFiles((prev) =>
                              on ? prev.filter((f) => f !== a.file) : [...prev, a.file],
                            )
                          }
                          disabled={sending}
                        >
                          {on ? <X className="size-3.5" /> : "Add"}
                        </Button>
                      </div>
                      <img
                        src={a.previewUrl}
                        alt={`${a.label} screenshot`}
                        className="max-h-40 w-full rounded border border-separator object-contain"
                      />
                      <Text variant="small" color="tertiary">
                        {formatBytes(a.bytes)}
                      </Text>
                    </div>
                  );
                })}
              </div>
              <Text variant="small" color="tertiary">
                A screenshot shows whatever the page rendered, including anything typed into it.
                Check each one before sending.
              </Text>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1">
              <Text variant="small">{containerName}</Text>
              <Select value={containerId} onValueChange={setContainerId} disabled={sending}>
                <SelectTrigger id="issue-container" className="w-56">
                  <SelectValue placeholder={`Choose a ${containerName.toLowerCase()}…`} />
                </SelectTrigger>
                <SelectContent>
                  {containers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.key ? `${c.key} — ${c.name}` : c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <label className="flex flex-col gap-1">
              <Text variant="small">{subContainerName}</Text>
              <Select
                value={subContainerId ?? NONE}
                onValueChange={(v) => setSubContainerId(v === NONE ? null : v)}
                disabled={sending || !containerId}
              >
                <SelectTrigger id="issue-sub-container" className="w-56">
                  <SelectValue placeholder={`No ${subContainerName.toLowerCase()}`} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No {subContainerName.toLowerCase()}</SelectItem>
                  {projectsForTeam.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>

          {labels.length > 0 ? (
            <div className="flex flex-col gap-1">
              <Text variant="small">Labels</Text>
              <div className="flex flex-wrap gap-1.5">
                {labels.map((l) => {
                  const on = labelIds.includes(l.id);
                  return (
                    <Button
                      key={l.id}
                      variant={on ? "secondary" : "muted"}
                      aria-pressed={on}
                      onClick={() =>
                        setLabelIds((prev) =>
                          on ? prev.filter((x) => x !== l.id) : [...prev, l.id],
                        )
                      }
                      disabled={sending}
                    >
                      {l.name}
                    </Button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {!containerId ? (
            <Text variant="small" color="secondary">
              Choose a {containerName.toLowerCase()} to send. You can set a default in Settings →
              Integrations.
            </Text>
          ) : null}

          {sendError ? (
            <div className="flex items-start gap-2 rounded-md border border-separator p-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <Text variant="small">{sendError}</Text>
            </div>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
