// The failure-reason row in the run Output panel: what KIND of failure this
// was, and the picker to say so.
//
// Sits above the triage line, and the two answer different questions on
// purpose: triage argues site-vs-test from evidence, this row is the label the
// team files the failure under — assigned automatically at run end when the
// evidence pointed somewhere, and correctable here because the automatic
// answer is a mapping, not a judgement. A label the user picks is never
// overwritten by the automatic path (see runHistoryStore.setFailureReason).
//
// Native-menu-backed `Select`, like every picker in this design: options never
// enter the DOM, so tests assert the displayed value and cover persistence at
// the IPC layer — and drive a change through the Menu.popup stub when they
// need the handler to run (the appearance-pane pattern).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@ui";
import { api } from "../lib/api";
import type { FailureReasonCatalog, RunRecord } from "../lib/recorder-types";

/** The picker's "no label" entry. A real state, not an error — an
 *  uncategorized failure is an open question, and the automatic path leaves
 *  it open rather than guessing (see shared/failure-reasons.mjs). */
const NONE = "none";

export function RunFailureReason({ runId }: { runId?: string }) {
  const qc = useQueryClient();
  const runsQuery = useQuery({ queryKey: ["runs"], queryFn: api.runs.list });
  const catalogQuery = useQuery({
    queryKey: ["failure-reasons"],
    queryFn: api.failureReasons.list,
  });

  const assign = useMutation({
    mutationFn: ({ id, reasonId }: { id: string; reasonId: string | null }) =>
      api.runs.setFailureReason(id, reasonId),
    onSuccess: (updated: RunRecord) => {
      // Patch the cached list in place; the backend's `runs:changed` push
      // refetches everything derived anyway, this just spares the picker a
      // visible round trip back to the old value.
      qc.setQueryData<RunRecord[]>(["runs"], (prev) =>
        prev?.map((r) => (r.id === updated.id ? updated : r)),
      );
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Couldn't set the failure reason.");
      // The optimistic value in the trigger is whatever the Select shows; a
      // refetch snaps every reader back to what the store actually holds.
      void qc.invalidateQueries({ queryKey: ["runs"] });
    },
  });

  const record = runId ? runsQuery.data?.find((r) => r.id === runId) : undefined;
  const catalog: FailureReasonCatalog | undefined = catalogQuery.data;
  // Only a recorded failure can be labelled — same guard as the tracker
  // button beside the panel's chip. No catalog means nothing to pick from.
  if (!record || record.status !== "failed" || !catalog) return null;

  const current = record.failureReasonId;
  // The picker offers built-ins plus ENABLED customs. A disabled or deleted
  // custom that is the CURRENT value still gets its item — the trigger renders the item
  // list's label for the value, and dropping it would show a blank where the
  // stored label is.
  const options = [
    ...catalog.builtin,
    ...catalog.custom.filter((c) => !(c.disabled || c.deleted) || c.id === current),
  ];
  // An id the catalog no longer knows (a store edited by hand, an import from
  // another machine): show the raw id rather than a blank — same honesty rule
  // as facetLabel's fallback.
  const unknownCurrent = current && !options.some((o) => o.id === current) ? current : null;

  return (
    <div className="gl-failure-reason" data-gl="failure-reason">
      <span className="gl-failure-reason-label" id="failure-reason-label">
        Reason
      </span>
      <Select
        value={current ?? NONE}
        onValueChange={(v) => {
          const next = v === NONE ? null : v;
          if ((next ?? undefined) === current) return;
          assign.mutate({ id: record.id, reasonId: next });
        }}
      >
        <SelectTrigger
          id="failure-reason-select"
          variant="filled"
          size="small"
          className="gl-failure-reason-trigger"
          aria-labelledby="failure-reason-label"
        >
          <SelectValue placeholder="Uncategorized" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Uncategorized</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.name}
            </SelectItem>
          ))}
          {unknownCurrent ? <SelectItem value={unknownCurrent}>{unknownCurrent}</SelectItem> : null}
        </SelectContent>
      </Select>
      {/* Says the label was assigned by the run-end mapping, not a person —
          the one fact that tells a reader whether it has been reviewed. */}
      {record.failureReasonBy === "auto" ? (
        <span className="gl-failure-reason-auto" title="Assigned automatically from triage evidence">
          auto
        </span>
      ) : null}
    </div>
  );
}
