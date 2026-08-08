// Create or edit a test group.
//
// A group is two membership RULES unioned together — tests named outright, and
// tests carrying a tag — so this dialog edits both and shows what they
// currently resolve to. The live count is the point: "Smoke — 7 tests" is the
// only way to tell a tag rule that matches what you meant from one that
// matches nothing, and a group that silently resolves to nothing is the
// failure worth catching here rather than at the moment someone runs it.

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  ScrollArea,
  Text,
  toast,
} from "@glaze/core/components";

import { api } from "../lib/api";
import { resolveGroupTests } from "../../shared/group-select.mjs";
import { tagCounts } from "../lib/test-tags";
import type { TestGroup, TestRecord } from "../lib/recorder-types";

export function GroupDialog({
  group,
  open,
  onClose,
}: {
  /** null = create a new group. */
  group: TestGroup | null;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: tests = [] } = useQuery({ queryKey: ["tests"], queryFn: api.tests.list });

  const [name, setName] = React.useState("");
  const [testIds, setTestIds] = React.useState<string[]>([]);
  const [tags, setTags] = React.useState<string[]>([]);
  // Seeded per group id (and once for "new"), the same latch idiom the run
  // controls use — this dialog can be reopened on a different group without
  // remounting, and a boolean "have I seeded" would show the previous one.
  const [seededFor, setSeededFor] = React.useState<string | null>(null);
  const seedKey = group?.id ?? "new";
  if (open && seededFor !== seedKey) {
    setSeededFor(seedKey);
    setName(group?.name ?? "");
    setTestIds(group?.testIds ?? []);
    setTags(group?.tags ?? []);
  }
  if (!open && seededFor !== null) setSeededFor(null);

  // What the rules mean right now — the same resolver the backend runs, so the
  // preview cannot disagree with what pressing Run would do.
  const resolved = React.useMemo(
    () => resolveGroupTests({ testIds, tags }, tests),
    [testIds, tags, tests],
  );
  const resolvedIds = React.useMemo(() => new Set(resolved.map((t) => t.id)), [resolved]);
  const allTags = React.useMemo(() => tagCounts(tests), [tests]);

  const save = useMutation({
    mutationFn: async () => {
      const trimmed = name.trim();
      if (group) return api.groups.update({ id: group.id, name: trimmed, testIds, tags });
      return api.groups.create({ name: trimmed, testIds, tags });
    },
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: ["groups"] });
      toast.success(group ? `Saved “${saved.name}”.` : `Created “${saved.name}”.`);
      onClose();
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : "Failed to save the group."),
  });

  const toggleTest = (id: string) =>
    setTestIds((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
  const toggleTag = (tag: string) =>
    setTags((prev) =>
      prev.some((t) => t.toLowerCase() === tag.toLowerCase())
        ? prev.filter((t) => t.toLowerCase() !== tag.toLowerCase())
        : [...prev, tag],
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="large"
      title={group ? "Edit group" : "New group"}
      description="A group runs a set of tests together. Pick tests outright, by tag, or both."
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input
            aria-label="Group name"
            value={name}
            placeholder="Smoke suite"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        {allTags.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Text variant="small" className="font-medium">
              Include every test with a tag
            </Text>
            <div className="flex flex-wrap gap-1.5">
              {allTags.map(({ tag, count }) => {
                const on = tags.some((t) => t.toLowerCase() === tag.toLowerCase());
                return (
                  <button
                    key={tag.toLowerCase()}
                    type="button"
                    aria-pressed={on}
                    aria-label={`Include tests tagged ${tag}`}
                    onClick={() => toggleTag(tag)}
                    className={`rounded-full border px-2 py-0.5 text-small transition-colors ${
                      on
                        ? "border-accent bg-accent-10 text-primary"
                        : "border-separator text-secondary hover:text-primary"
                    }`}
                  >
                    {tag} · {count}
                  </button>
                );
              })}
            </div>
            <Text variant="small" color="tertiary">
              A tag rule picks up tests tagged later, with no edit here.
            </Text>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <Text variant="small" className="font-medium">
            Or pick tests
          </Text>
          {tests.length === 0 ? (
            <Text variant="small" color="tertiary">
              No tests yet.
            </Text>
          ) : (
            <ScrollArea className="max-h-64 rounded-md border border-separator" viewportClassName="max-h-64">
              <div className="flex flex-col p-1">
                {tests.map((t: TestRecord) => {
                  const picked = testIds.includes(t.id);
                  // A test already matched by a tag rule is shown as included,
                  // so the list can't imply it will be left out.
                  const viaTag = !picked && resolvedIds.has(t.id);
                  return (
                    <label
                      key={t.id}
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-small hover:bg-background-secondary"
                    >
                      <Checkbox
                        checked={picked}
                        onCheckedChange={() => toggleTest(t.id)}
                        aria-label={`Include ${t.name} in this group`}
                      />
                      <span className="min-w-0 flex-1 truncate text-primary">{t.name}</span>
                      {viaTag ? <Badge color="secondary">via tag</Badge> : null}
                    </label>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* The number is the check on the rules above: a group that resolves
              to nothing looks identical to a working one until it is run. */}
          <Text variant="small" color={resolved.length === 0 ? "danger" : "secondary"}>
            {resolved.length === 0
              ? "No tests match yet — this group would have nothing to run."
              : `${resolved.length} test${resolved.length === 1 ? "" : "s"} in this group.`}
          </Text>
          <div className="flex-1" />
          <Button variant="glass" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="accent"
            disabled={!name.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {group ? "Save" : "Create group"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
