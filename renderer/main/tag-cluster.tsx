// The Batch view's tag cluster: one pill per tag, each doubling as a filter and
// as the place that tag gets deleted from the library.
//
// CREATING tags stays where it already was — the sidebar's right-click → Edit
// Tags… — because that's where you know which test you're labelling. Deleting
// is the opposite shape: it's a library-wide act, and this row is the only
// place the whole tag vocabulary is on screen at once, with counts. Putting the
// delete anywhere else would mean opening a test to remove a label that isn't
// really about that test.
//
// Two things the confirm step is actually for. A tag is the batch's grouping
// key, so deleting one silently re-scopes what "run smoke" means — the count
// is what tells you how big that is before you commit. And unlike editing one
// test's tags, this can't be undone by re-typing: the tag is gone from N tests
// and nothing remembers which ones.
//
// Deletion is ONE backend call (`tests:deleteTag`), not a loop over the
// affected tests — see the handler for why.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertDialog, Badge, Text, toast } from "@ui";
import { Tag, X } from "lucide-react";

import { api } from "../lib/api";
import { ALL_TAGS, UNTAGGED, tagCounts, untaggedCount } from "../lib/test-tags";
import type { TestRecord } from "../lib/recorder-types";

/** How many test names the confirm dialog lists before it summarizes. Enough to
 *  recognize the group, few enough that the dialog doesn't scroll. */
const MAX_NAMES_SHOWN = 8;

/** One pill. `trailing` is the delete affordance, absent for All/Untagged —
 *  those are views over the library, not tags anyone can remove.
 *
 *  A `<span>` wrapper rather than one big `<button>`: the delete control is a
 *  button in its own right, and a button inside a button is invalid markup that
 *  swallows the inner click. */
function TagChip({
  label,
  count,
  active,
  disabled,
  onClick,
  trailing,
}: {
  label: string;
  count: number;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-stretch overflow-hidden rounded-pill border text-small transition-colors ${
        active
          ? "border-accent bg-accent/12 text-primary"
          : "border-secondary text-secondary hover:border-primary"
      } ${disabled ? "opacity-50" : ""}`}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-pressed={active}
        className={`py-0.5 pl-2.5 transition-colors hover:bg-control-subtle disabled:cursor-default ${
          trailing ? "pr-2" : "pr-2.5"
        }`}
      >
        {label} · {count}
      </button>
      {trailing ? (
        <>
          <span aria-hidden="true" className="my-1 w-px shrink-0 bg-separator" />
          {trailing}
        </>
      ) : null}
    </span>
  );
}

/** The X, wired to a confirm. The X IS the dialog's trigger, so there's no
 *  open-state to keep in sync and focus returns to the chip on cancel.
 *
 *  Visible at rest rather than revealed on hover: a hover-only X on a pill this
 *  small is undiscoverable, and it's the entire affordance. Muted, though — it
 *  sits beside the count, which is what you're usually reading. The red wash on
 *  its own hover is what says "destructive", so it can stay quiet until then. */
function DeleteTagButton({
  tag,
  tests,
  disabled,
  onConfirm,
}: {
  tag: string;
  /** Every test carrying this tag — the count the user is shown, and the names
   *  that make it concrete. */
  tests: { id: string; name: string }[];
  disabled?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const shown = tests.slice(0, MAX_NAMES_SHOWN);
  const rest = tests.length - shown.length;

  return (
    <AlertDialog
      trigger={
        <button
          type="button"
          disabled={disabled}
          aria-label={`Delete tag ${tag}`}
          title={`Delete “${tag}” from every test`}
          className="flex items-center px-1.5 text-tertiary transition-colors hover:bg-support-red-10 hover:text-support-red disabled:cursor-default disabled:opacity-40"
        >
          <X className="size-3" />
        </button>
      }
      size="small"
      title={`Delete the tag “${tag}”?`}
      description={
        tests.length === 1
          ? "1 test uses it. The test stays in your library — only the tag is removed, and it can’t be undone."
          : `${tests.length} tests use it. They stay in your library — only the tag is removed, and it can’t be undone.`
      }
      confirmLabel="Delete tag"
      confirmVariant="destructive"
      onConfirm={onConfirm}
    >
      {tests.length > 0 ? (
        <div className="flex flex-col gap-2">
          <Text variant="small" color="tertiary">
            {tests.length === 1 ? "Tagged test" : `Tagged tests · ${tests.length}`}
          </Text>
          <div className="flex flex-wrap items-center gap-1.5">
            {shown.map((t) => (
              <Badge key={t.id} color="secondary">
                {t.name}
              </Badge>
            ))}
            {rest > 0 ? (
              <Text variant="small" color="tertiary">
                +{rest} more
              </Text>
            ) : null}
          </div>
        </div>
      ) : null}
    </AlertDialog>
  );
}

export function TagCluster({
  tests,
  value,
  onChange,
  disabled,
}: {
  tests: TestRecord[];
  /** Current filter: a tag name, or the `ALL_TAGS` / `UNTAGGED` sentinels. */
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const qc = useQueryClient();
  const [deleting, setDeleting] = React.useState<string | null>(null);

  const tags = React.useMemo(() => tagCounts(tests), [tests]);
  const untagged = React.useMemo(() => untaggedCount(tests), [tests]);

  // Grouped case-insensitively, exactly as `tagCounts` does — the dialog must
  // name the same tests the chip counted, or the confirmation lies.
  const testsByTag = React.useMemo(() => {
    const map = new Map<string, { id: string; name: string }[]>();
    for (const t of tests) {
      for (const tag of t.tags ?? []) {
        const key = tag.toLowerCase();
        const list = map.get(key);
        if (list) list.push({ id: t.id, name: t.name });
        else map.set(key, [{ id: t.id, name: t.name }]);
      }
    }
    return map;
  }, [tests]);

  const remove = async (tag: string) => {
    setDeleting(tag);
    try {
      const res = await api.tests.deleteTag(tag);
      // Every surface that renders a tag reads one of these two — the library
      // list (sidebar, this cluster) and the per-test record (detail view).
      qc.invalidateQueries({ queryKey: ["tests"] });
      qc.invalidateQueries({ queryKey: ["test"] });
      // The backend's count, not the one the dialog showed: hidden tests carry
      // tags too and aren't in this list, so reporting the preview here could
      // under-report what actually changed.
      toast.success(
        res.removed === 1
          ? `Removed “${res.tag}” from 1 test.`
          : `Removed “${res.tag}” from ${res.removed} tests.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete the tag.");
    } finally {
      setDeleting(null);
    }
  };

  if (tags.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-card border border-secondary bg-well px-2 py-1.5">
      <Tag className="mx-0.5 size-3.5 shrink-0 text-tertiary" aria-hidden="true" />
      <TagChip
        label="All"
        count={tests.length}
        active={value === ALL_TAGS}
        disabled={disabled}
        onClick={() => onChange(ALL_TAGS)}
      />
      {tags.map((t) => (
        <TagChip
          key={t.tag.toLowerCase()}
          label={t.tag}
          count={t.count}
          active={value.toLowerCase() === t.tag.toLowerCase()}
          disabled={disabled}
          onClick={() => onChange(t.tag)}
          trailing={
            <DeleteTagButton
              tag={t.tag}
              tests={testsByTag.get(t.tag.toLowerCase()) ?? []}
              disabled={disabled || deleting !== null}
              onConfirm={() => remove(t.tag)}
            />
          }
        />
      ))}
      {untagged > 0 ? (
        <TagChip
          label="Untagged"
          count={untagged}
          active={value === UNTAGGED}
          disabled={disabled}
          onClick={() => onChange(UNTAGGED)}
        />
      ) : null}
    </div>
  );
}
