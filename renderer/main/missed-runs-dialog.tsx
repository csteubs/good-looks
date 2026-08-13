// "This did not run while you were away." docs/ROUTINES.md capability 2.
//
// THE HALF THAT MAKES THE CAVEAT TRUE. `SCHEDULE_CAVEAT` promises two things:
// a schedule runs only while the app is open, AND a missed run is offered when
// you next launch it. The scheduler computes the second (`routines:missed`);
// this is where it is offered. Without it the sentence beside every schedule
// would be half a lie, which is worse than the weaker guarantee it exists to
// state honestly.
//
// IT OFFERS, IT DOES NOT RUN. A suite that seizes the machine the moment you
// launch the app — for a run you may not want right now, on a commit you may
// have already moved past — is how people turn scheduling off. Both buttons
// settle the occurrence: running it stamps it, and so does declining, because
// otherwise this dialog returns on every launch forever.
//
// ONE ROUTINE AT A TIME, oldest first. The batch runner runs one batch at a
// time anyway, so offering four at once would be offering three that get
// refused. Answering one brings up the next.
//
// OUTSIDE `RootShell`, like `LoadFailedDialog` and for a related reason: this
// has to be able to appear whatever screen the user landed on, including while
// a recording session has swapped the outlet out entirely.

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertDialog, toast } from "@ui";

import { api } from "../lib/api";
import { describeSchedule } from "../../shared/routine-schedule.mjs";

export function MissedRunsDialog(): React.ReactElement | null {
  const qc = useQueryClient();
  // ASKED ONCE, at mount. The answer is about occurrences missed before the app
  // opened, so it cannot change while it is open — refetching would only give
  // the same list, and a prompt that reappears because a query refocused is a
  // prompt people learn to dismiss without reading.
  const { data: missed = [] } = useQuery({
    queryKey: ["routines-missed"],
    queryFn: api.routines.missed,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  // Ids answered this session, so the dialog advances rather than re-asking.
  // Local rather than a refetch: the backend's answer changes as each is
  // settled, but the ORDER should not shift under a dialog somebody is reading.
  const [answered, setAnswered] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);

  const pending = missed.filter((r) => !answered.includes(r.id));
  const routine = pending[0];
  if (!routine) return null;

  const settle = () => {
    setAnswered((prev) => [...prev, routine.id]);
    setBusy(false);
    void qc.invalidateQueries({ queryKey: ["routines"] });
  };

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        // Dismissing by Escape or the overlay is the same answer as Cancel —
        // and it must SETTLE, or the prompt returns on the next launch and the
        // one after that.
        if (open || busy) return;
        setBusy(true);
        api.routines
          .dismissMissed(routine.id)
          .catch(() => toast.error("Could not dismiss that missed run."))
          .finally(settle);
      }}
      size="small"
      title={`"${routine.name}" did not run while you were away`}
      description={`It is scheduled ${describeSchedule(routine.schedule).toLowerCase()}, and the last occurrence was missed. Run it now?`}
      confirmLabel="Run it now"
      confirmDisabled={busy}
      onConfirm={() => {
        setBusy(true);
        api.routines
          .runMissed(routine.id)
          .then((res) => {
            if (res.outcome === "alreadyRunning") toast.info("A batch is already running.");
            else if (res.outcome === "blocked") toast.error(res.reason ?? "Nothing to run.");
          })
          .catch(() => toast.error("Could not start that routine."))
          .finally(settle);
      }}
    />
  );
}
