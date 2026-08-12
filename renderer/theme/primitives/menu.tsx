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

  const close = React.useCallback(() => setOpen(false), []);

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
        <div className="gl-menu" role="menu" aria-label={label}>
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}
