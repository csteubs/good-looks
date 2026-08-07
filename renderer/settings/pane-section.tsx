// A titled group of rows inside a pane.
//
// Thin over the SDK's `FieldSet`/`FieldGroup`, with one job of its own: a
// section whose every row has been filtered away by a search removes ITSELF,
// rather than leaving a heading over an empty rounded box.
//
// It works out which rows it holds by reading the `id` prop off its children
// instead of taking a second list of ids. A duplicated list is a list that
// drifts — the section would keep showing for a row that was renamed, or
// vanish for one that was added — and there is no way to notice from the
// screen, because the failure only appears mid-search.

import { Children, isValidElement } from "react";
import type { ReactNode } from "react";
import { FieldGroup, FieldSet } from "@glaze/core/components";

import { useMatchedIds } from "./setting-row";

/** The `id` of every direct child that declares one. Fragments are flattened
 *  by `Children.toArray`; conditional `null`/`false` children drop out. */
function childIds(children: ReactNode): string[] {
  const ids: string[] = [];
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) continue;
    const props = child.props as { id?: unknown };
    if (typeof props.id === "string") ids.push(props.id);
  }
  return ids;
}

export function PaneSection({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  const matched = useMatchedIds();
  const ids = childIds(children);

  // No search running, or a section of bare content with no identified rows
  // (the storage readout) — always shown. Otherwise it survives only if one of
  // its own rows did.
  const visible =
    matched === null || ids.length === 0 || ids.some((id) => matched.indexOf(id) !== -1);
  if (!visible) return null;

  return (
    <FieldSet title={title} description={description}>
      <FieldGroup>{children}</FieldGroup>
    </FieldSet>
  );
}
