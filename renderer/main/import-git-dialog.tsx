import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, Field, Input, Text, toast } from "@ui";

import { api } from "../lib/api";

export function ImportGitDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [url, setUrl] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const reset = () => {
    setUrl("");
    setError(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Import from git URL"
      description="Clone a repository and import every Playwright test file (*.spec.ts / *.test.ts) it contains."
      confirmLabel="Import"
      confirmDisabled={url.trim().length === 0}
      onConfirm={async () => {
        setError(null);
        try {
          const res = await api.tests.importGit(url.trim());
          qc.invalidateQueries({ queryKey: ["tests"] });
          toast.success(
            res.imported === 1
              ? `Imported 1 test from the repository.`
              : `Imported ${res.imported} tests from the repository.`,
          );
          if (res.ids[0]) navigate({ to: "/test/$id", params: { id: res.ids[0] } });
          reset();
        } catch (err) {
          // Re-throw keeps the dialog open for retry (see Dialog semantics).
          setError(err instanceof Error ? err.message : String(err));
          throw err;
        }
      }}
    >
      <div className="flex flex-col gap-3">
        <Field label="Repository URL" orientation="vertical">
          <Input
            placeholder="https://github.com/user/repo.git"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus
          />
        </Field>
        {error ? (
          <Text variant="small" color="red">
            {error}
          </Text>
        ) : (
          <Text variant="small" color="secondary">
            Cloning may take a moment for large repositories.
          </Text>
        )}
      </div>
    </Dialog>
  );
}
