// A menu that flies out sideways from a rail row.
//
// ── WHY THIS IS PORTALLED, which is the whole reason the file is this long ──
//
// `SplitView` renders the sidebar as `<div style={{width}} class="h-full
// shrink-0 overflow-hidden">`. An absolutely-positioned panel inside the rail
// is therefore CLIPPED at the rail's right edge — it renders, it has a size, it
// is in the accessibility tree, and roughly none of it is on screen. That is
// the failure mode this repo keeps a family of source-level checks for
// (`check:clickable-chrome`, `check:scroll-layout`): jsdom has no layout engine,
// so every rendered test passes against a menu the user cannot see.
//
// So the panel goes into a portal on `document.body` and is positioned `fixed`
// from the trigger's own rect. A portal also sidesteps the second version of
// the same trap — a `transform` or `filter` on any ancestor makes even `fixed`
// resolve against that ancestor instead of the viewport, and this app paints
// atmosphere overlays.
//
// The property that prevents the clipping is testable even in jsdom, because it
// is structural rather than visual: the panel must not be a descendant of the
// rail. `rail-flyout.test.tsx` asserts exactly that. The COORDINATES are not
// testable here — `getBoundingClientRect` returns zeros — and are checked by
// looking at the running app.
//
// ── The four behaviours a hand-rolled hover menu gets half-right ──────
//
// Same list as `primitives/menu.tsx`, plus the two that only hover has:
//
//   • Opening on hover needs an INTENT DELAY. Without it, dragging the pointer
//     down the rail past the row flashes a menu open and shut, and the flash
//     lands on top of whatever the user was actually reaching for.
//   • Closing needs a GRACE DELAY, and the pointer handlers go on a wrapper
//     that contains both the row and the panel. Moving from the row into the
//     panel then never fires `pointerleave` at all — the classic "menu closes
//     while you are travelling to it" bug is a structural problem, and this is
//     the structural fix rather than a bigger timeout.
//   • Escape closes and returns focus to the trigger, or the caret is dropped
//     at the top of the document.
//   • A `pointerdown` outside closes. Not `click`: a click fires on release, so
//     a menu that closes on click is still open while the user is pressing the
//     thing behind it.
//
// Hover alone would make this mouse-only, so the trigger also opens on
// ArrowRight/ArrowDown and the panel does its own up/down roving between
// `role="menuitem"` elements.

import * as React from "react";
import { createPortal } from "react-dom";

/** Long enough that crossing the row on the way somewhere else does not open
 *  it; short enough that deliberately resting on it feels immediate. */
const OPEN_DELAY_MS = 140;
/** Covers the pointer leaving the wrapper by a few pixels mid-travel. The gap
 *  between row and panel is closed structurally, so this is only for overshoot. */
const CLOSE_DELAY_MS = 220;
/** Kept off the window edges when the panel is taller than the space below. */
const VIEWPORT_MARGIN = 8;

export interface RailFlyoutTriggerProps {
  ref: React.Ref<HTMLButtonElement>;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}

export interface RailFlyoutProps {
  /** Names the menu for assistive tech. The trigger's own label does not say
   *  what the popup it announces is a popup OF. */
  label: string;
  /** The row. Given props it MUST spread onto its focusable element. */
  children: (trigger: RailFlyoutTriggerProps) => React.ReactNode;
  /** The menu's contents — `role="menuitem"` elements, which the panel's arrow
   *  keys move between. */
  panel: React.ReactNode;
  /** Suppresses the menu without unmounting the row. */
  disabled?: boolean;
  /** Observability for tests and callers that care (e.g. to refetch on open). */
  onOpenChange?: (open: boolean) => void;
}

interface Placement {
  left: number;
  /** Distance from the viewport's bottom edge to the row's — see `measure`.
   *  The panel is pinned by its BOTTOM so that growing taller moves its top
   *  edge up rather than pushing its bottom off the window. */
  bottom: number;
  /** Space the panel may occupy before it must scroll. */
  maxHeight: number;
}

export function RailFlyout({
  label,
  children,
  panel,
  disabled,
  onOpenChange,
}: RailFlyoutProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [placement, setPlacement] = React.useState<Placement | null>(null);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const openTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = React.useCallback(() => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  // One place that changes the state, so the callback can never be skipped by a
  // path that set it directly.
  const setOpenState = React.useCallback(
    (next: boolean) => {
      setOpen((prev) => {
        if (prev !== next) onOpenChange?.(next);
        return next;
      });
    },
    [onOpenChange],
  );

  const close = React.useCallback(() => {
    clearTimers();
    setOpenState(false);
  }, [clearTimers, setOpenState]);

  /**
   * Where the panel goes: to the right of the rail, its BOTTOM edge aligned
   * with the row's, so a menu on a row pinned near the bottom of the window
   * grows upward into the space that exists.
   *
   * ── ANCHORED BY `bottom`, NOT BY `top`, AND THAT IS THE WHOLE POINT ───
   * The first version computed a `top` from the panel's measured height. It
   * looked right in every situation where the menu's contents were already
   * known — and this menu's contents usually are NOT: nothing is fetched until
   * the first open, so the panel is placed while it still says "Reading
   * branches…" and then gets five rows taller a moment later. Pinned by `top`,
   * that growth goes DOWNWARD, straight off the bottom of the window. It cost a
   * second measure pass, a re-measure on resize, and it was still wrong.
   *
   * Anchoring the bottom edge makes growth upward a property of the layout
   * rather than something to keep recomputing: whatever height the panel takes,
   * its bottom stays on the row and the top rises. `maxHeight` is the space
   * between the window's top margin and that edge, so a very long menu scrolls
   * inside itself instead of escaping either end.
   *
   * Found by opening the menu on a cold launch and watching it get cut off at
   * the window's edge. jsdom cannot see it: `getBoundingClientRect` is zeros,
   * so every placement number is 0 and every test passes either way.
   */
  const measure = React.useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewportHeight = window.innerHeight || 0;
    setPlacement({
      left: rect.right,
      // Distance from the viewport's bottom up to the row's bottom edge.
      bottom: Math.max(0, viewportHeight - rect.bottom),
      maxHeight: Math.max(0, rect.bottom - VIEWPORT_MARGIN),
    });
  }, []);

  const openNow = React.useCallback(() => {
    if (disabled) return;
    clearTimers();
    measure();
    setOpenState(true);
  }, [clearTimers, disabled, measure, setOpenState]);

  // ── Hover intent ─────────────────────────────────────────────────
  const onPointerEnter = () => {
    if (disabled) return;
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (open || openTimer.current !== null) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      openNow();
    }, OPEN_DELAY_MS);
  };

  const onPointerLeave = () => {
    if (openTimer.current !== null) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (!open) return;
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpenState(false);
    }, CLOSE_DELAY_MS);
  };

  React.useEffect(() => clearTimers, [clearTimers]);

  // A disabled row must not keep a menu open that was opened before it became
  // disabled — the branch switcher going unavailable mid-hover, say.
  React.useEffect(() => {
    if (disabled && open) close();
  }, [close, disabled, open]);

  // ── Dismissal ────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      triggerRef.current?.focus();
    };
    // Not `scroll` on a specific element: the rail's nav does not scroll, but
    // the window can be resized and the app can be zoomed, and a panel left at
    // a stale rect is a menu floating away from its row.
    const reposition = () => measure();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", reposition);
    };
  }, [close, measure, open]);


  // ── Keyboard ─────────────────────────────────────────────────────
  const focusItem = React.useCallback((index: number) => {
    const items = panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (!items || items.length === 0) return;
    const wrapped = ((index % items.length) + items.length) % items.length;
    items[wrapped]?.focus();
  }, []);

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    // Enter and Space are left alone: the row is a real button whose click does
    // something (navigates to the full view), and hijacking them would make the
    // keyboard path disagree with the pointer one.
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      openNow();
      // After paint, so the items exist to receive focus.
      requestAnimationFrame(() => focusItem(0));
    }
  };

  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    if (event.key === "ArrowLeft") {
      close();
      triggerRef.current?.focus();
      return;
    }
    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    const current = items.indexOf(document.activeElement as HTMLElement);
    focusItem(current + (event.key === "ArrowDown" ? 1 : -1));
  };

  return (
    <div
      ref={rootRef}
      className="gl-rail-flyout-root"
      data-gl="rail-flyout"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {children({
        ref: triggerRef,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        onKeyDown: onTriggerKeyDown,
      })}
      {open && !disabled
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              aria-label={label}
              className="gl-rail-flyout"
              data-gl="rail-flyout-panel"
              style={{
                left: placement?.left ?? 0,
                bottom: placement?.bottom ?? 0,
                maxHeight: placement?.maxHeight ?? undefined,
              }}
              // Belt and braces, NOT the mechanism. React propagates events
              // from a portal along the REACT tree rather than the DOM tree, so
              // the wrapper above already sees the pointer arrive here —
              // removing these two lines leaves every test in
              // `rail-flyout.test.tsx` passing, which is how that was found.
              // They stay because the behaviour they back up is the one users
              // notice instantly (a menu that vanishes while you travel to it),
              // and because that propagation rule is a React implementation
              // detail rather than something this file should depend on.
              onPointerEnter={onPointerEnter}
              onPointerLeave={onPointerLeave}
              onKeyDown={onPanelKeyDown}
            >
              {panel}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
