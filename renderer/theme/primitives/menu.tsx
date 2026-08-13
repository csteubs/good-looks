// Menu — the box `MenuItem` goes in.
//
// THE SDK'S `Select` IS KEPT EVERYWHERE ELSE, and this is the documented
// exception. That one is backed by a real macOS menu (`Menu.popup`), which is
// the right answer for a list of labels and the wrong one here: a native menu
// item is a string, and the whole point of `MenuItem` is the SECOND LINE — what
// choosing this actually costs. REDESIGN §8.2 names the three places that draw
// their own menu for exactly this reason (concurrency, stats scope, appearance)
// and points out the upside: the options are real DOM, so for the first time
// they can be driven in a test instead of asserted at the IPC layer.
//
// Not Radix's `DropdownMenu` either — the one in `@ui` renders its items to
// `null` and hands a plain-data template to the native popup, so composing
// `MenuItem` into it would produce an empty menu with no error anywhere.
//
// What this owns is the four behaviours a hand-rolled dropdown always gets
// half-right:
//
//   • Escape closes it and returns focus to the trigger. Without the return,
//     keyboard users are dropped at the top of the document.
//   • A pointer-down anywhere else closes it. `pointerdown`, not `click`:
//     a click fires after the pointer goes up, so a menu that closes on click
//     is still open while the user is pressing the thing behind it.
//   • The trigger reports `aria-expanded`, so a screen reader knows the state
//     the arrow is describing visually.
//   • Choosing an item closes it. A menu that stays open after a choice reads
//     as though the choice did not take.
//
//   • THE KEYBOARD PATTERN ITS ROLES PROMISE. `role="menu"` with
//     `role="menuitem"` children is a specific claim to assistive tech: arrow
//     keys move between items and Tab leaves. This shipped making that claim
//     with no key handler at all — ArrowDown did nothing, and every item was
//     tabbable, so the only way through was Tab, four stops on the way to the
//     next control. That was the fifth behaviour, and it was missing precisely
//     because the list above said there were four.
//
//     Opening moves focus to the item IN FORCE (`aria-current`), not the first
//     one — the same place a native menu opens, and opening on "Off" when the
//     batch is set to 2 invites changing a setting the user came to read.

import * as React from "react";

export interface MenuProps {
  /** What the trigger reads when closed — the choice currently in force. */
  value: string;
  /** Names the control for assistive tech; the value alone does not say what
   *  it is a value OF. */
  label: string;
  disabled?: boolean;
  /** Width of the trigger in px. Menus in a toolbar row need to agree. */
  width?: number;
  className?: string;
  /** `MenuItem`s. `close` lets an item dismiss the menu after acting. */
  children: (close: () => void) => React.ReactNode;
}

export function Menu({
  value,
  label,
  disabled,
  width,
  className,
  children,
}: MenuProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);

  const close = React.useCallback(() => setOpen(false), []);

  /** The items, in DOM order, skipping disabled ones — arrow keys must not
   *  park on a choice that cannot be made. Read from the DOM rather than
   *  tracked in state because the items are the caller's children: `Menu` is
   *  handed a render function, so it never sees how many there are. */
  const enabledItems = React.useCallback(
    (): HTMLElement[] =>
      Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
      ),
    [],
  );

  /** Move focus, and move the single tab stop with it. Roving tabindex is what
   *  makes Tab leave the menu instead of walking it. */
  const focusItem = React.useCallback(
    (next: HTMLElement | undefined): void => {
      if (!next) return;
      for (const el of enabledItems()) el.tabIndex = el === next ? 0 : -1;
      next.focus();
    },
    [enabledItems],
  );

  // On open: focus the choice in force, else the first item.
  React.useEffect(() => {
    if (!open) return;
    const all = enabledItems();
    const current = all.find((el) => el.getAttribute("aria-current") === "true");
    focusItem(current ?? all[0]);
  }, [open, enabledItems, focusItem]);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      // Focus goes back where it came from. Without this the caret lands at the
      // top of the document and the next Tab starts from the beginning.
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className={["gl-menu-root", className].filter(Boolean).join(" ")} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="gl-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        style={width !== undefined ? { width } : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="gl-menu-trigger-value">{value}</span>
        <span className="gl-menu-trigger-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <div
          className="gl-menu"
          role="menu"
          aria-label={label}
          ref={menuRef}
          onKeyDown={(e) => {
            // Tab CLOSES rather than moves within. Deliberately not
            // preventDefault-ed: closing without letting Tab move strands the
            // caret on the trigger, which reads as a dead Tab key.
            if (e.key === "Tab") {
              setOpen(false);
              return;
            }
            const all = enabledItems();
            if (all.length === 0) return;
            const at = all.indexOf(document.activeElement as HTMLElement);
            let next: HTMLElement | undefined;
            if (e.key === "ArrowDown") next = all[(at + 1) % all.length];
            else if (e.key === "ArrowUp") next = all[(at - 1 + all.length) % all.length];
            else if (e.key === "Home") next = all[0];
            else if (e.key === "End") next = all[all.length - 1];
            else return;
            // Only now — an unhandled key must keep its default, or typing in a
            // menu that grows a filter field later silently stops working.
            e.preventDefault();
            focusItem(next);
          }}
        >
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}
