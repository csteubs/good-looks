// Import a repository of Playwright tests, by URL.
//
// THE SHAPE IS GITHUB'S CLONE WIDGET (B10), because that is the control every
// user of this feature has already used: a protocol tab row, a monospace URL
// field, one line of caption. There is no "GitHub CLI" tab — it means nothing
// to an importer, and two working protocols beat a decorative third.
//
// THE TABS ARE A HINT, NOT A VALIDATOR. The backend accepts https, git@, ssh
// and git:// whatever the row says, so pasting an SSH URL under HTTPS flips the
// tab rather than raising an error. A control that rejects a URL the app would
// have accepted is worse than no control.
//
// `Segmented` rather than Radix `Tabs`: it is plain buttons with `aria-pressed`,
// so `fireEvent.click` drives it (a `TabsTrigger` activates on pointer-down and
// silently leaves the assertion running against the previous tab), and its
// active item is neutral — `check:selection-neutral` draws that line, and a
// coloured protocol tab would be claiming to report an outcome.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, toast } from "@ui";

import { Segmented } from "../theme";
import { api } from "../lib/api";
import { importWarnings } from "../lib/import-warnings";
import { RunBrowserField, useRunBrowserChoice } from "./run-browser-field";

type Protocol = "https" | "ssh";

const PROTOCOLS = [
  { value: "https" as const, label: "HTTPS" },
  { value: "ssh" as const, label: "SSH" },
];

const PLACEHOLDER: Record<Protocol, string> = {
  https: "https://github.com/user/repo.git",
  ssh: "git@github.com:user/repo.git",
};

/** Which tab a pasted URL belongs under. Null when it is neither — a half-typed
 *  URL must not make the tab row twitch on every keystroke. */
export function protocolOf(url: string): Protocol | null {
  const clean = url.trim();
  if (/^(git@|ssh:\/\/)/i.test(clean)) return "ssh";
  if (/^(https?:\/\/|git:\/\/)/i.test(clean)) return "https";
  return null;
}

export function ImportGitDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [protocol, setProtocol] = React.useState<Protocol>("https");
  const [url, setUrl] = React.useState("");
  const [branch, setBranch] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const browser = useRunBrowserChoice(open);

  const reset = () => {
    setUrl("");
    setBranch("");
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
          const res = await api.tests.importGit(
            url.trim(),
            branch.trim() || undefined,
            browser.toStore,
          );
          qc.invalidateQueries({ queryKey: ["tests"] });
          toast.success(
            res.imported === 1
              ? `Imported 1 test from the repository.`
              : `Imported ${res.imported} tests from the repository.`,
          );
          // Same warnings as the folder import, from the same place: a cloned
          // repository is missing a base URL for exactly the same reasons.
          for (const w of importWarnings(res)) toast.warning(w);
          if (res.ids[0]) navigate({ to: "/test/$id", params: { id: res.ids[0] } });
          reset();
          // The composed `Dialog` never closes itself on a resolved confirm —
          // callers close themselves (see `dialog-actions.test.tsx`). This one
          // is mounted by the library rail, OUTSIDE the outlet RootShell swaps,
          // so nothing else would ever take it down.
          onOpenChange(false);
        } catch (err) {
          // The failure path deliberately does NOT close: the message renders
          // inline and the typed URL is still there to correct and retry.
          //
          // This used to re-throw, on the belief that a rejected confirm is
          // what kept the dialog open. It is not — `DialogActions` calls
          // `void onConfirm()` and reads nothing back, so the throw only ever
          // produced an unhandled rejection while the dialog stayed open for
          // the unrelated reason that NOTHING closes it.
          setError(err instanceof Error ? err.message : String(err));
        }
      }}
    >
      <div className="gl-clone">
        <Segmented
          options={PROTOCOLS}
          value={protocol}
          onChange={setProtocol}
          label="Repository URL protocol"
          className="gl-clone-tabs"
        />

        <input
          className="gl-input gl-clone-url"
          placeholder={PLACEHOLDER[protocol]}
          aria-label="Repository URL"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            // The paste-flips-the-tab rule. Only when the text actually names a
            // protocol — otherwise the row flickers while somebody types.
            const guessed = protocolOf(e.target.value);
            if (guessed) setProtocol(guessed);
          }}
          autoFocus
        />

        <div className="gl-clone-branch">
          <span className="gl-section-title" id="clone-branch-label">
            Branch or tag
          </span>
          <input
            className="gl-input"
            placeholder="default branch"
            aria-labelledby="clone-branch-label"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          />
        </div>

        <RunBrowserField
          value={browser.value}
          onChange={browser.onChange}
          hint="The engine runs use, applied to every test this import brings in."
        />

        {error ? (
          <p className="gl-note gl-clone-error">{error}</p>
        ) : (
          <p className="gl-note">
            Imports every Playwright spec in the repository. Cloning may take a moment for a large
            one.
          </p>
        )}
      </div>
    </Dialog>
  );
}
