// Heals tab on a test's detail view — the review queue for Auto-Heal.
//
// Auto-Heal changes what a step points at. Before the journal, it did that
// silently whenever the retry succeeded, which is worse than it sounds: a
// mis-heal usually SUCCEEDS. Clicking the wrong button rarely throws, so the
// step was marked passed and the test quietly stopped testing what it was
// written to test.
//
// So this panel's job is not to make healing look clever. It is to make every
// heal visible, say plainly whether the stored test was changed, and put both
// directions one click away.

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Callout,
  ScrollArea,
  Text,
  toast,
} from "@glaze/core/components";
import { Check, RotateCcw, Wand2 } from "lucide-react";

import { api } from "../lib/api";
import { formatLocator } from "./refine-selector-dialog";
import type { HealEntry, Locator, TestRecord } from "../lib/recorder-types";

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function HealRow({
  entry,
  onAccept,
  onRevert,
  busy,
}: {
  entry: HealEntry;
  onAccept: (locator?: Locator) => void;
  onRevert: () => void;
  busy: boolean;
}) {
  const [showAll, setShowAll] = React.useState(false);
  const settled = entry.status !== "pending";
  // Alternatives the user can pick instead of the engine's choice. The one
  // already applied is dropped — offering it again reads as a second option
  // when it isn't one.
  const alternatives = entry.candidates.filter(
    (c) =>
      !(
        c.locator.k === entry.appliedLocator.k &&
        c.locator.v === entry.appliedLocator.v &&
        c.locator.role === entry.appliedLocator.role &&
        c.locator.name === entry.appliedLocator.name
      ),
  );

  return (
    <div className="flex flex-col gap-2 rounded-md border border-separator p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Wand2 className="size-4 text-tertiary" />
        <Text weight="medium" className="min-w-0 truncate">
          {entry.stepLabel || `Step ${entry.stepIndex + 1}`}
        </Text>
        <Badge variant="secondary">{entry.source === "run" ? "During a run" : "In the trainer"}</Badge>
        {/* The distinction that matters most: was the saved test changed? */}
        {entry.applied ? (
          <Badge color="orange">Applied to the test</Badge>
        ) : (
          <Badge color="blue">Suggestion only</Badge>
        )}
        {entry.status === "accepted" ? <Badge color="green">Accepted</Badge> : null}
        {entry.status === "reverted" ? <Badge variant="secondary">Reverted</Badge> : null}
        <div className="flex-1" />
        <Text size="small" className="text-tertiary">
          {fmtWhen(entry.at)}
        </Text>
      </div>

      <div className="flex flex-col gap-1 font-mono text-xs">
        {entry.originalLocator ? (
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 font-sans text-tertiary">was</span>
            <code className="min-w-0 truncate line-through text-tertiary">
              {formatLocator(entry.originalLocator)}
            </code>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <span className="w-14 shrink-0 font-sans text-tertiary">now</span>
          <code className="min-w-0 truncate text-primary">
            {formatLocator(entry.appliedLocator)}
          </code>
        </div>
      </div>

      {!settled ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="small" disabled={busy} onClick={() => onAccept()}>
            <Check className="size-4" />
            {entry.applied ? "Keep" : "Apply"}
          </Button>
          <Button size="small" variant="secondary" disabled={busy} onClick={onRevert}>
            <RotateCcw className="size-4" />
            {entry.applied ? "Revert" : "Dismiss"}
          </Button>
          {alternatives.length > 0 ? (
            <Button size="small" variant="ghost" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Hide" : `${alternatives.length} other candidate${alternatives.length === 1 ? "" : "s"}`}
            </Button>
          ) : null}
        </div>
      ) : null}

      {showAll ? (
        <div className="flex flex-col gap-1">
          {alternatives.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-secondary">
                {formatLocator(c.locator)}
              </code>
              {c.matchedPastRun ? <Badge variant="secondary">seen before</Badge> : null}
              <Button
                size="small"
                variant="ghost"
                disabled={busy}
                onClick={() => onAccept(c.locator)}
              >
                Use this
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function HealsPanel({ test }: { test: TestRecord }) {
  const qc = useQueryClient();
  const heals = useQuery({
    queryKey: ["heals", test.id],
    queryFn: () => api.heals.list(test.id),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["heals", test.id] });
    void qc.invalidateQueries({ queryKey: ["test", test.id] });
  };

  const accept = useMutation({
    mutationFn: (p: { id: string; locator?: Locator }) => api.heals.accept(p.id, p.locator),
    onSuccess: () => {
      invalidate();
      toast.success("Applied to the test");
    },
    onError: (err: unknown) => toast.error(String(err)),
  });

  const revert = useMutation({
    mutationFn: (id: string) => api.heals.revert(id),
    onSuccess: invalidate,
    onError: (err: unknown) => toast.error(String(err)),
  });

  const clearSettled = useMutation({
    mutationFn: () => api.heals.clearSettled(test.id),
    onSuccess: invalidate,
    onError: (err: unknown) => toast.error(String(err)),
  });

  const entries = heals.data ?? [];
  const pending = entries.filter((e) => e.status === "pending");
  const settled = entries.filter((e) => e.status !== "pending");
  const busy = accept.isPending || revert.isPending;
  // An applied-but-unreviewed heal is the case worth calling out: the test on
  // disk has already changed and nobody has looked at it.
  const appliedPending = pending.filter((e) => e.applied).length;

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 p-4">
        {appliedPending > 0 ? (
          <Callout color="orange">
            {appliedPending} step{appliedPending === 1 ? " has" : "s have"} already been changed by
            Auto-Heal. Review below — a heal that succeeded is not the same as a heal that was
            right.
          </Callout>
        ) : null}

        <div className="flex items-center gap-2">
          <Text weight="medium">Needs review</Text>
          {pending.length > 0 ? <Badge color="blue">{pending.length}</Badge> : null}
        </div>

        {heals.isLoading ? (
          <Text size="small" className="text-tertiary">
            Loading…
          </Text>
        ) : pending.length === 0 ? (
          <Text size="small" className="text-tertiary">
            Nothing to review. Auto-Heal records every locator it changes here, with a way to put it
            back.
          </Text>
        ) : (
          <div className="flex flex-col gap-2">
            {pending.map((e) => (
              <HealRow
                key={e.id}
                entry={e}
                busy={busy}
                onAccept={(locator) => accept.mutate({ id: e.id, locator })}
                onRevert={() => revert.mutate(e.id)}
              />
            ))}
          </div>
        )}

        {settled.length > 0 ? (
          <>
            <div className="flex items-center gap-2 pt-2">
              <Text weight="medium">History</Text>
              <div className="flex-1" />
              <Button
                size="small"
                variant="ghost"
                disabled={clearSettled.isPending}
                onClick={() => clearSettled.mutate()}
              >
                Clear history
              </Button>
            </div>
            <div className="flex flex-col gap-2">
              {settled.map((e) => (
                <HealRow key={e.id} entry={e} busy={busy} onAccept={() => {}} onRevert={() => {}} />
              ))}
            </div>
          </>
        ) : null}
      </div>
    </ScrollArea>
  );
}
