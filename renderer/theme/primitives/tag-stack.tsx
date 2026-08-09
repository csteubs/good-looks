// TagStack — overlapped marks plus a count, opening to a menu.
//
// A test can carry a dozen tags and a row has ~118px for them. The three
// obvious answers are all worse than this one: truncating loses the tags at the
// end with no sign they existed, wrapping breaks the row grid that makes the
// list scannable, and a bare count ("12 tags") says nothing about WHICH.
//
// So: the first few as overlapping marks — enough to recognise the familiar
// ones at a glance — and a count for the rest. The overlap is what buys the
// room, and it is deliberately slight, because marks stacked to the point of
// hiding each other's initials are just a worse count.
//
// THE COUNT IS A BUTTON, NOT A LABEL. "+9" that cannot be opened is the
// truncation problem again with extra steps. Clicking opens the menu with all
// of them, and the menu is where they are actionable (filter by this tag, run
// this tag, remove it).
//
// Built on real buttons and native `title` for the same reasons as `Segmented`:
// Radix tooltips cannot be opened under jsdom, so hover-only text is untestable,
// and pointer-down activation makes `fireEvent.click` silently do nothing.

import * as React from "react";

export interface TagStackProps {
  tags: ReadonlyArray<string>;
  /** How many to draw before collapsing the rest into the count. Three fits the
   *  118px cell the batch row gives this. */
  max?: number;
  /** Opens the full list. Absent makes the stack purely informational — the
   *  count is then a plain label, because a button that does nothing is worse
   *  than no button. */
  onOpen?: () => void;
  label?: string;
}

export function TagStack({
  tags,
  max = 3,
  onOpen,
  label = "Tags",
}: TagStackProps): React.ReactElement | null {
  if (tags.length === 0) return null;

  const shown = tags.slice(0, max);
  const hidden = tags.length - shown.length;
  // The whole list, always, whatever is drawn. Someone deciding whether to open
  // the menu needs to know if it is worth opening.
  const full = tags.join(", ");

  const content = (
    <>
      {shown.map((tag, i) => (
        <span
          key={tag}
          className="gl-tag-mark"
          // Slight, on purpose: marks stacked until they hide each other's
          // initials are just a worse count.
          style={{ marginInlineStart: i === 0 ? 0 : -5, zIndex: shown.length - i }}
          data-tag={tag}
        >
          {tag.slice(0, 2).toUpperCase()}
        </span>
      ))}
      {hidden > 0 ? <span className="gl-tag-count">+{hidden}</span> : null}
    </>
  );

  if (onOpen === undefined) {
    return (
      <span className="gl-tag-stack" data-gl="tag-stack" title={full} aria-label={`${label}: ${full}`}>
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="gl-tag-stack"
      data-gl="tag-stack"
      title={full}
      aria-label={`${label}: ${full}`}
      onClick={onOpen}
    >
      {content}
    </button>
  );
}
