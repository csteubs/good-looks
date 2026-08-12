// The rows inside the branch hover menu.
//
// Presentational: it is handed a `BranchMenuModel` (built by
// `renderer/lib/branch-menu.ts`, which owns every ordering and matching rule)
// and draws it. The split is deliberate — a hover flyout is the worst surface
// on which to debug a sort, and this file has no logic worth testing through
// one.
//
// ── Two buttons per row, never a button inside a button ───────────────
// A row does two different things: choosing the branch, and opening its pull
// request. Nesting the icon inside the row button is invalid HTML, and browsers
// resolve it by dropping the inner control — so the icon would render and do
// nothing, on a menu where "nothing happened" is already the expected outcome
// of hovering. Two siblings in a flex row, each `role="menuitem"`, which is
// also what `RailFlyout`'s arrow keys move between.
//
// ── The pull-request icon opens the real browser ──────────────────────
// Through `nativeShell().openExternal`, which the main process validates
// (https, github.com only — `main/shell/external-url.ts`). The URL comes
// straight from the API's `html_url`; this file does not construct one, which
// is why there is no github.com string anywhere in the renderer for
// `check:renderer-egress` to have an opinion about.

import * as React from "react";
import { GitBranch, GitPullRequest, Home } from "lucide-react";

import type { BranchMenuEntry, BranchMenuModel } from "../lib/branch-menu";
import { nativeShell } from "../lib/native-shell";

export interface BranchMenuProps {
  model: BranchMenuModel;
  /** Chosen a row. `null` is the pinned row — return to the checkout. */
  onChoose: (branch: string | null) => void;
  /** The footer, which goes to the full Branches view. */
  onSeeAll: () => void;
  /** True while the branch list is still being fetched, so an empty menu can
   *  say "loading" rather than "no branches" — those are different facts and
   *  only one of them is worth acting on. */
  loading?: boolean;
}

function BranchMenuRow({
  entry,
  onChoose,
}: {
  entry: BranchMenuEntry;
  onChoose: (branch: string | null) => void;
}): React.ReactElement {
  const pull = entry.pull;
  return (
    <div className="gl-rail-flyout-row">
      <button
        type="button"
        role="menuitem"
        className="gl-rail-flyout-item"
        // Absent rather than `false`: `[data-current]` matches an empty
        // attribute, so a literal "false" would style every row as current.
        // Same trap `RailRow`'s `data-selected` documents.
        data-current={entry.current ? "" : undefined}
        aria-current={entry.current ? "true" : undefined}
        onClick={() => onChoose(entry.branch)}
      >
        <span className="gl-rail-flyout-item-icon">
          {entry.home ? <Home aria-hidden="true" /> : <GitBranch aria-hidden="true" />}
        </span>
        <span className="gl-rail-flyout-item-text">
          <span className="gl-rail-flyout-item-title">{entry.label}</span>
          <span className="gl-rail-flyout-item-sub">{entry.detail}</span>
        </span>
      </button>
      {pull ? (
        <button
          type="button"
          role="menuitem"
          className="gl-rail-flyout-pr"
          // The number is the useful part of the name: "open pull request" on
          // six rows tells a screen-reader user nothing about which.
          aria-label={`Open pull request #${pull.number} on GitHub${pull.draft ? " (draft)" : ""}: ${pull.title}`}
          title={`#${pull.number} ${pull.title}${pull.draft ? " (draft)" : ""}`}
          onClick={() => nativeShell().openExternal(pull.url)}
        >
          <GitPullRequest aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function BranchMenu({
  model,
  onChoose,
  onSeeAll,
  loading,
}: BranchMenuProps): React.ReactElement {
  const branchRows = model.entries.filter((e) => !e.home);
  return (
    <>
      <div className="gl-rail-flyout-label">Branches</div>
      {model.entries
        .filter((e) => e.home)
        .map((entry) => (
          <BranchMenuRow key="home" entry={entry} onChoose={onChoose} />
        ))}
      <div className="gl-rail-flyout-sep" role="separator" />
      {branchRows.length > 0 ? (
        branchRows.map((entry) => (
          <BranchMenuRow key={entry.branch} entry={entry} onChoose={onChoose} />
        ))
      ) : (
        <p className="gl-rail-flyout-empty">
          {loading ? "Reading branches…" : "No other branches on origin."}
        </p>
      )}
      <div className="gl-rail-flyout-sep" role="separator" />
      <button type="button" role="menuitem" className="gl-rail-flyout-item" onClick={onSeeAll}>
        <span className="gl-rail-flyout-item-text">
          <span className="gl-rail-flyout-item-title">All branches and pull requests…</span>
          <span className="gl-rail-flyout-item-sub">
            {/* The count is the reason this row is worth reading. "…" alone
                does not say whether there is anything else to find. */}
            {model.hidden > 0
              ? `${model.hidden} more branch${model.hidden === 1 ? "" : "es"}`
              : "Open the Branches view"}
          </span>
        </span>
      </button>
    </>
  );
}
