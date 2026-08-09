// The "here's what a copy of this does" dialog.
//
// Purely presentational: it is handed the warnings rather than deriving them,
// because the decision to show it at ALL is the same decision as what to put in
// it (`describeDuplicationWarnings` returning nothing means duplicate silently).
// Computing them in here would mean a component that sometimes renders no
// dialog and instead fires a mutation from an effect.
//
// Not a confirmation of something dangerous — duplicating is cheap and a copy
// is one right-click from being deleted. It exists so the two genuine surprises
// arrive before the copy does rather than a week later: what came WITH the copy
// (a stored password, a recorded session cookie), and what deliberately did not
// (every run the original has ever had).

import { Dialog, Text } from "@ui";
import { Copy } from "lucide-react";

import { NOT_COPIED, type DuplicationWarning } from "../lib/duplicate-warnings";

// The copy's name is NOT predicted here. The backend picks the number against
// every test on disk, hidden ones included, and the sidebar can only see the
// visible ones — so a name shown up front could differ from the one that lands.
// The toast reports the real name once it exists.
export function DuplicateTestDialog({
  testName,
  warnings,
  open,
  busy,
  onOpenChange,
  onConfirm,
}: {
  testName: string;
  warnings: DuplicationWarning[];
  open: boolean;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Duplicate “${testName}”?`}
      description="A few things behave differently in a copy:"
      confirmLabel={busy ? "Duplicating…" : "Duplicate"}
      confirmDisabled={busy}
      onConfirm={onConfirm}
      size="medium"
    >
      <div className="flex flex-col gap-4">
        <ul className="flex flex-col gap-3">
          {warnings.map((w) => (
            <li key={w.id} className="flex gap-2.5">
              <Copy className="mt-0.5 size-4 shrink-0 text-secondary" aria-hidden />
              <div className="flex flex-col gap-0.5">
                <Text variant="small" className="font-medium">
                  {w.title}
                </Text>
                <Text variant="small" color="secondary">
                  {w.detail}
                </Text>
              </div>
            </li>
          ))}
        </ul>

        <div className="flex flex-col gap-1 border-t border-separator pt-3">
          <Text variant="small" color="secondary" className="font-medium">
            Not copied
          </Text>
          <Text variant="small" color="tertiary">
            {NOT_COPIED.join(" · ")}
          </Text>
        </div>
      </div>
    </Dialog>
  );
}
