// Edit a test's grouping tags.
//
// Two ways in: type a comma-separated list, or click one of the tags already
// used elsewhere in the library to toggle it. The second matters more than it
// looks — free-form tags rot fast when the only affordance is typing, because
// "checkout" and "check-out" both get created and neither groups anything.
//
// Normalization (trim/dedupe/cap/sort) happens BACKEND-side in `normalizeTags`,
// so this dialog sends raw strings and re-renders whatever comes back. That
// keeps one source of truth rather than two that can disagree.

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Dialog, Field, Input, Text, toast } from "@ui";

import { api } from "../lib/api";
import { parseTagInput, tagCounts } from "../lib/test-tags";
import type { TestRecord } from "../lib/recorder-types";

export function TagsDialog({
  test,
  open,
  onOpenChange,
}: {
  test: TestRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const { data: tests = [] } = useQuery({ queryKey: ["tests"], queryFn: api.tests.list });
  const [value, setValue] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  // Reseed whenever a different test is opened (or its tags changed elsewhere).
  React.useEffect(() => {
    if (!open) return;
    setValue((test?.tags ?? []).join(", "));
  }, [open, test]);

  const current = parseTagInput(value);
  const currentKeys = new Set(current.map((t) => t.toLowerCase()));

  // Tags in use elsewhere, offered as one-click toggles.
  const suggestions = React.useMemo(
    () => tagCounts(tests).filter((t) => !currentKeys.has(t.tag.toLowerCase())),
    [tests, currentKeys],
  );

  const toggle = (tag: string) => {
    setValue(current.concat(tag).join(", "));
  };

  const save = async () => {
    if (!test) return;
    setSaving(true);
    try {
      await api.tests.setTags(test.id, current);
      qc.invalidateQueries({ queryKey: ["tests"] });
      qc.invalidateQueries({ queryKey: ["test", test.id] });
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save tags.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={test ? `Tags for “${test.name}”` : "Tags"}
      description="Group tests so you can run a subset as a routine. Separate tags with commas."
      confirmLabel={saving ? "Saving…" : "Save"}
      onConfirm={save}
    >
      <div className="flex flex-col gap-4">
        <Field>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="smoke, checkout, nightly"
            autoFocus
          />
        </Field>

        {current.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {current.map((t) => (
              <Badge key={t.toLowerCase()} color="secondary">
                {t}
              </Badge>
            ))}
          </div>
        ) : (
          <Text variant="small" color="tertiary">
            No tags — this test will show under “Untagged”.
          </Text>
        )}

        {suggestions.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <Text variant="small" color="secondary">
              Used elsewhere
            </Text>
            <div className="flex flex-wrap items-center gap-1.5">
              {suggestions.map((s) => (
                <button
                  key={s.tag.toLowerCase()}
                  type="button"
                  onClick={() => toggle(s.tag)}
                  className="rounded-full border border-separator px-2 py-0.5 text-small text-secondary transition-colors hover:bg-control-subtle"
                >
                  {s.tag} · {s.count}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
