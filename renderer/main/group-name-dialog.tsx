// Name a library folder — REDESIGN §7.2.
//
// Used for both halves of the same gesture, because they ARE the same gesture:
// "New Group…" on a test and "Rename…" on a folder both come down to "what is
// this folder called", and a group is nothing but its name (see
// `TestRecord.group`). Renaming is therefore MOVING every member to a new
// name, which is why the copy says so rather than pretending a record is being
// edited.
//
// The field is capped at the store's own limit, so it cannot produce a value
// the backend would have to truncate — the same rule the Routine editor's
// message field follows. Normalization still happens backend-side; this only
// stops the user typing something that silently loses its tail.

import * as React from "react";
import { Dialog, Field, Input, Text } from "@ui";

import { MAX_GROUP_LENGTH } from "../lib/recorder-types";

export function GroupNameDialog({
  open,
  title,
  description,
  initial,
  confirmLabel,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description: string;
  /** The name to start from — empty when creating. */
  initial: string;
  confirmLabel: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string) => void;
}) {
  const [value, setValue] = React.useState(initial);

  // Reseed on every open, not once on mount: the dialog instance is reused for
  // whichever folder or test is acted on next, so a stale value here would
  // rename the wrong thing with the previous one's name.
  React.useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  const trimmed = value.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      // An empty name is refused rather than accepted as "ungroup". Deleting a
      // folder is its own menu command with its own words; getting there by
      // clearing a text field would be a destructive action with no way to tell
      // it apart from a slip.
      confirmDisabled={trimmed === ""}
      onConfirm={() => {
        if (trimmed === "") return;
        onSubmit(trimmed);
        onOpenChange(false);
      }}
    >
      <div className="flex flex-col gap-3">
        <Field>
          <Input
            value={value}
            maxLength={MAX_GROUP_LENGTH}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Checkout"
            aria-label="Group name"
            autoFocus
            onKeyDown={(e) => {
              if (e.key !== "Enter" || trimmed === "") return;
              onSubmit(trimmed);
              onOpenChange(false);
            }}
          />
        </Field>
        <Text variant="small" color="tertiary">
          A test belongs to one group. Tags are the other thing — a test can
          carry as many of those as you like, and Routines filter by them.
        </Text>
      </div>
    </Dialog>
  );
}
