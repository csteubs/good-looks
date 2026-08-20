// Names the flow a trainer selection is about to become. Shared by both
// trainers so the gesture cannot drift between them. The backend owns the
// real validation (shared/flow-extraction.mjs plus the name-collision check)
// and rejects with sentences — this dialog's job is to show them next to the
// field instead of losing them to a toast behind the training browser.

import * as React from "react";
import { Dialog, Field, Input, Text } from "@ui";

export function CreateFlowDialog({
  open,
  onOpenChange,
  count,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** How many steps the selection holds, for the description. */
  count: number;
  /** Resolves on success (the host clears its selection); rejects with a
   *  message meant to be shown beside the field. */
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setName("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the flow a name.");
      return;
    }
    setBusy(true);
    try {
      await onCreate(trimmed);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!busy) onOpenChange(o);
      }}
      title="Create a flow from the selection"
      description={`The ${count} selected step${count === 1 ? "" : "s"} move into a new reusable flow, and a single “run flow” step takes their place here. Other tests can then call it.`}
      confirmLabel={busy ? "Creating…" : "Create flow"}
      confirmVariant="accent"
      onConfirm={submit}
    >
      <div className="flex flex-col gap-2">
        <Field label="Flow name" orientation="vertical">
          <Input
            autoFocus
            size="small"
            value={name}
            placeholder="Sign in"
            aria-label="Flow name"
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </Field>
        {error ? (
          <Text size="small" className="text-support-red">
            {error}
          </Text>
        ) : null}
      </div>
    </Dialog>
  );
}
