import * as React from "react";
import { Dialog, Field, Input } from "@glaze/core/components";

import { useRecorder } from "./recorder-store";

export function NewRecordingDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { start } = useRecorder();
  const [url, setUrl] = React.useState("");
  const [name, setName] = React.useState("");
  const canStart = url.trim().length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New recording"
      description="Enter a site to record. It opens in a browser window, and every interaction becomes a test step."
      confirmLabel="Start recording"
      confirmDisabled={!canStart}
      onConfirm={async () => {
        await start(url.trim(), name.trim() || "Recorded test");
        setUrl("");
        setName("");
      }}
    >
      <div className="flex flex-col gap-3">
        <Field label="URL" orientation="vertical">
          <Input
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Test name" orientation="vertical">
          <Input placeholder="My test" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
