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

import { useEffect, useMemo, useState } from "react";
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
  const stepId = source.kind === "failure" ? (source.stepId ?? "") : source.stepId;
  const ruleId = source.kind === "a11y" ? source.ruleId : "";
  return (
    links.find(
      (l) => l.kind === source.kind && l.stepId === stepId && l.ruleId === ruleId,
    ) ?? null
  );
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

  /** Non-null when this defect already has an issue — the dialog then offers a
   *  comment instead of a second issue. */
  const [existing, setExisting] = useState<IssueLink | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Everything the dialog needs, in one pass when it opens. Reset first so a
  // second defect never renders against the previous one's draft — the failure
  // there is silent and it files the wrong thing.
  useEffect(() => {
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
          api.issues.linksForTest(source.testId).catch(() => [] as IssueLink[]),
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
        const [teams, projects, allLabels] = await Promise.all([
          api.issues.listContainers().catch(() => []),
          api.issues.listSubContainers().catch(() => []),
          api.issues.listLabels().catch(() => []),
        ]);
        if (cancelled) return;
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
  }, [open, source]);

  const containerName = vocab?.container ?? "Team";
  const subContainerName = vocab?.subContainer ?? "Project";
  const providerName = vocab?.name ?? "Linear";

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
              {kept.length} screenshot{kept.length === 1 ? "" : "s"} from this run will go with it.
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
                  : `${kept.length} screenshot${kept.length === 1 ? "" : "s"} will be attached`}
              </Text>
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
