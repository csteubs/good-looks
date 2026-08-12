// Stats → Report. REDESIGN §6.5.
//
// What the mockup drew here was an "Export" panel with PDF and "public link"
// chips and a list of delivery CHANNELS with toggles. None of those are built,
// and §7.3 said so first: rewrite that copy "before it ships, or it promises a
// Slack integration that does not exist". A public link needs a server this app
// does not have and PDF needs a renderer it does not carry.
//
// So this lists EMITTERS. The rows come from `shared/emitters.mjs`'s own
// `EMITTERS` array rather than being written out here, which is the difference
// between a list that can go stale and one that cannot: an emitter added to the
// module appears here without anyone remembering to add it.
//
// THE PANEL NEVER HOLDS THE EMITTED TEXT. It calls `api.report.emit` — a verb —
// and gets back a path and a byte count. Redaction runs in the main process
// against an encrypted store that cannot cross the boundary, so a panel that
// asked for the bytes and saved them itself would be redacting a copy of
// something that had already left. That is why "where it goes" here is a record
// of what was WRITTEN rather than a preview of what would be.

import * as React from "react";
import { Text, toast } from "@ui";
import { Download } from "lucide-react";

import { Btn } from "../theme";
import { api } from "../lib/api";
import { EMITTERS } from "../../shared/emitters.mjs";
import type { EmitterId } from "../../shared/emitters.mjs";

/** `YYYY-MM-DD`, for the suggested filename. Built here and passed down so the
 *  name the user is offered is the one this panel chose — the emitter module is
 *  pure and does not read a clock. */
function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface Written {
  path: string;
  bytes: number;
  count: number;
}

export function ReportPanel({ testId }: { testId?: string }): React.ReactElement {
  // Keyed by emitter, because "last written" is a fact about ONE format. A
  // single slot would make exporting a second file look like it replaced the
  // first, which is the opposite of what the list is for.
  const [written, setWritten] = React.useState<Record<string, Written>>({});
  const [busy, setBusy] = React.useState<EmitterId | null>(null);

  const emit = async (id: EmitterId) => {
    setBusy(id);
    try {
      const result = await api.report.emit(id, today(Date.now()), testId);
      // A cancel is not a failure and gets no toast: the user closed a save
      // dialog, which is an answer, and telling them what they just did reads
      // as the app not having noticed.
      if (result.cancelled || !result.path) return;
      setWritten((prev) => ({
        ...prev,
        [id]: { path: result.path as string, bytes: result.bytes, count: result.count },
      }));
      toast.success("Written.", { description: result.path });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not write that file.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="gl-report" aria-label="Report">
      <div className="gl-report-head">
        <Text variant="small" color="secondary">
          Every file below is written to disk and nothing is sent. Secrets are
          stripped on the way out — but an emitted file leaves this machine by
          definition, so read one before you forward it.
        </Text>
      </div>

      <div className="gl-report-list">
        {EMITTERS.map((emitter) => {
          const last = written[emitter.id];
          return (
            <div key={emitter.id} className="gl-report-row">
              <div className="gl-report-main">
                <Text variant="small" className="gl-report-label">
                  {emitter.label}
                </Text>
                <Text variant="small" color="tertiary" className="gl-report-summary">
                  {emitter.summary}
                </Text>
                {/* Per-emitter rather than once at the top. §7.3 names the two
                    that carry the most, and a general warning about "exports"
                    is not read as being about the row under the cursor. */}
                {emitter.risk ? (
                  <Text variant="small" className="gl-report-risk">
                    {emitter.risk}
                  </Text>
                ) : null}
                {/* Where it went — the honest version of the mockup's channel
                    list. Not "this is connected to Slack": this is the file
                    that was last written, and nothing else happened to it. */}
                {last ? (
                  <Text variant="small" color="tertiary" className="gl-report-written">
                    {`Last written: ${last.path} · ${formatBytes(last.bytes)} · ${last.count} row${last.count === 1 ? "" : "s"}`}
                  </Text>
                ) : null}
              </div>
              <Btn
                onClick={() => void emit(emitter.id as EmitterId)}
                disabled={busy !== null}
                aria-label={`Emit ${emitter.label}`}
              >
                <Download className="size-3.5" />
                {busy === emitter.id ? "Writing…" : "Emit"}
              </Btn>
            </div>
          );
        })}
      </div>
    </section>
  );
}
