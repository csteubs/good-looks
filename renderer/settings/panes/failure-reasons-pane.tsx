// Settings → Failure reasons: the automatic-categorization switch, the
// built-in vocabulary, and the editor for custom reasons.
//
// Two rules from the store surface here as UI shape rather than copy:
//
//   • RENAME IN PLACE. The edit form updates the reason's record; runs store
//     the id, so the new name reaches every historical label the moment the
//     save lands.
//   • DISABLE OR DELETE, AND HISTORY KEEPS ITS LABEL EITHER WAY. Disabling
//     hides a reason from the picker and stops new assignments; deleting
//     also takes it off this list. The store keeps a deleted reason as a
//     tombstone, so every run already filed under it keeps its name — which
//     is what the confirm dialog says before it happens. Adding the same name
//     again restores it (same id), so the list never needs a "deleted" section.
//   • BUILT-INS ARE LISTED, NOT EDITABLE. They are what the automatic
//     categorizer can assign, and renaming them would detach the triage
//     mapping from the words the docs and the Stats breakdown use.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { AlertDialog, Button, Input, Switch, toast } from "@ui";
import { api } from "../../lib/api";
import type { CustomFailureReason } from "../../lib/recorder-types";
import {
  MAX_ACTIVE_CUSTOM_REASONS,
  MAX_REASON_DESCRIPTION,
  MAX_REASON_NAME,
} from "../../../shared/failure-reasons.mjs";
import { PaneSection } from "../pane-section";
import { SettingRow } from "../setting-row";
import { useSettingsController } from "../settings-controller";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function FailureReasonsPane() {
  const { settings, save } = useSettingsController();
  const qc = useQueryClient();

  const catalog = useQuery({ queryKey: ["failure-reasons"], queryFn: api.failureReasons.list });

  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  // One reason in edit mode at a time; opening another closes the first,
  // discarding its draft — the same single-draft rule the variables panel uses.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");

  const refetch = () => void qc.invalidateQueries({ queryKey: ["failure-reasons"] });

  const create = useMutation({
    mutationFn: () => api.failureReasons.create(newName, newDescription),
    onSuccess: () => {
      setNewName("");
      setNewDescription("");
      refetch();
    },
    // The store's messages are written for people ("already a built-in
    // reason", "limited to 50") — forward them rather than translating.
    onError: (err: unknown) => toast.error(errorText(err)),
  });

  const update = useMutation({
    mutationFn: (input: {
      id: string;
      patch: { name?: string; description?: string; disabled?: boolean };
    }) => api.failureReasons.update(input.id, input.patch),
    onSuccess: () => {
      setEditingId(null);
      refetch();
    },
    onError: (err: unknown) => toast.error(errorText(err)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.failureReasons.remove(id),
    onSuccess: refetch,
    onError: (err: unknown) => toast.error(errorText(err)),
  });

  // Deleted reasons stay in the catalog so history resolves their names; they
  // are simply not the editor's any more.
  const custom = (catalog.data?.custom ?? []).filter((r) => !r.deleted);
  const builtin = catalog.data?.builtin ?? [];
  const activeCount = custom.filter((r) => !r.disabled).length;

  function beginEdit(reason: CustomFailureReason): void {
    setEditingId(reason.id);
    setEditName(reason.name);
    setEditDescription(reason.description);
  }

  return (
    <>
      <PaneSection>
        <SettingRow
          id="auto-failure-reasons"
          label="Categorize failures automatically"
          summary="Labels each failed run with a built-in reason at run end, mapped from the same evidence the triage line shows."
          details="Deterministic and local — no AI is involved and nothing leaves this Mac. A run whose evidence points nowhere stays uncategorized, and a reason you set by hand is never overwritten. Custom reasons are yours to assign; the automatic pass only uses the built-ins."
        >
          <Switch
            id="auto-failure-reasons"
            checked={settings.autoFailureReasons ?? true}
            onCheckedChange={(checked) => void save({ autoFailureReasons: checked })}
          />
        </SettingRow>
      </PaneSection>

      <PaneSection
        title="Vocabulary"
        description="What the run panel's picker offers, and what the Stats board groups failures by."
      >
        <SettingRow
          id="builtin-failure-reasons"
          label="Built-in reasons"
          stacked
          summary="Always available, and the only reasons the automatic pass can assign. They can't be renamed or removed."
        >
          <ul className="flex w-full flex-col gap-1">
            {builtin.map((r) => (
              <li key={r.id} className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 text-sm">{r.name}</span>
                <span className="min-w-0 truncate text-xs opacity-60">{r.description}</span>
              </li>
            ))}
          </ul>
        </SettingRow>

        <SettingRow
          id="custom-failure-reasons"
          label="Custom reasons"
          stacked
          summary={
            <>
              Failure modes specific to how you work — an expired credential, a third-party
              outage — instead of forcing them into a broad built-in. Renaming one updates every
              run already filed under it. Disabling hides it from the picker; deleting also removes
              it from this list. Either way, the runs it already labels keep the label. Up to{" "}
              {MAX_ACTIVE_CUSTOM_REASONS} can be active.
            </>
          }
        >
          <div className="flex w-full flex-col gap-3">
            {custom.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {custom.map((reason) =>
                  editingId === reason.id ? (
                    <li key={reason.id} className="flex flex-col gap-2">
                      <Input
                        value={editName}
                        maxLength={MAX_REASON_NAME}
                        onChange={(e) => setEditName(e.target.value)}
                        aria-label={`New name for ${reason.name}`}
                        className="min-w-0"
                      />
                      <Input
                        value={editDescription}
                        maxLength={MAX_REASON_DESCRIPTION}
                        onChange={(e) => setEditDescription(e.target.value)}
                        aria-label={`New description for ${reason.name}`}
                        placeholder="Description (optional)"
                        className="min-w-0"
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          variant="secondary"
                          disabled={update.isPending || editName.trim().length === 0}
                          onClick={() =>
                            update.mutate({
                              id: reason.id,
                              patch: { name: editName, description: editDescription },
                            })
                          }
                        >
                          Save
                        </Button>
                        <Button variant="transparent" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </li>
                  ) : (
                    <li key={reason.id} className="flex items-center gap-2">
                      <span className={`min-w-0 flex-1 truncate text-sm${reason.disabled ? " opacity-50" : ""}`}>
                        {reason.name}
                        {reason.description ? (
                          <span className="ml-2 text-xs opacity-60">{reason.description}</span>
                        ) : null}
                      </span>
                      <Button
                        variant="secondary"
                        aria-label={`Rename ${reason.name}`}
                        onClick={() => beginEdit(reason)}
                        disabled={update.isPending}
                      >
                        Rename
                      </Button>
                      <Button
                        variant="secondary"
                        aria-label={`${reason.disabled ? "Enable" : "Disable"} ${reason.name}`}
                        onClick={() =>
                          update.mutate({ id: reason.id, patch: { disabled: !reason.disabled } })
                        }
                        disabled={update.isPending}
                      >
                        {reason.disabled ? "Enable" : "Disable"}
                      </Button>
                      <AlertDialog
                        trigger={
                          <Button
                            variant="secondary"
                            aria-label={`Delete ${reason.name}`}
                            disabled={update.isPending || remove.isPending}
                          >
                            Delete
                          </Button>
                        }
                        size="small"
                        title={`Delete “${reason.name}”?`}
                        description="It leaves this list and the run panel's picker. Runs already labelled with it keep the label. Adding a reason with this name again restores it."
                        confirmLabel="Delete reason"
                        confirmVariant="destructive"
                        onConfirm={() => remove.mutate(reason.id)}
                      />
                    </li>
                  ),
                )}
              </ul>
            ) : null}

            <div className="flex w-full flex-col gap-2">
              <Input
                id="custom-failure-reasons"
                value={newName}
                maxLength={MAX_REASON_NAME}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Third-party vendor outage"
                aria-label="New reason name"
                disabled={create.isPending}
                className="min-w-0"
              />
              <Input
                value={newDescription}
                maxLength={MAX_REASON_DESCRIPTION}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Description (optional) — shown in the picker and the Stats breakdown"
                aria-label="New reason description"
                disabled={create.isPending}
                className="min-w-0"
              />
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  aria-label="Add custom reason"
                  onClick={() => create.mutate()}
                  disabled={
                    create.isPending ||
                    newName.trim().length === 0 ||
                    activeCount >= MAX_ACTIVE_CUSTOM_REASONS
                  }
                >
                  Add
                </Button>
              </div>
            </div>
          </div>
        </SettingRow>
      </PaneSection>
    </>
  );
}
