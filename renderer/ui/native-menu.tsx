// Native-menu-backed Select and DropdownMenu.
//
// These deliberately keep the original design system's architecture rather than
// becoming Radix DOM menus: item components render `null`, the tree is walked
// into a plain-data template, and the template is handed to the main process
// via `glazeAPI.Menu.popup`, which answers with the chosen commandId. Two
// reasons to preserve it:
//
//   1. It is a real macOS menu — correct placement, keyboard behaviour and
//      appearance, and it can overflow the window bounds. A DOM menu inside a
//      560×480 settings window cannot.
//   2. The app's tests drive these by stubbing `glazeAPI.Menu.popup` and
//      asserting on the rendered value (see the note in CLAUDE.md about the
//      SDK's Select never putting options in the DOM). Keeping the contract
//      keeps those tests testing the real thing.
//
// The trade-off is unchanged from the original: options are not in the DOM, so
// a selection cannot be driven in jsdom — assert the displayed value and cover
// persistence at the IPC layer.

import * as React from "react";

import { cn } from "./cn";
import { Button } from "./primitives";

/* ── Template building ──────────────────────────────────────────────── */

interface NativeItem {
  label?: string;
  type?: "separator" | "normal";
  enabled?: boolean;
  checked?: boolean;
  commandId?: number;
  submenu?: NativeItem[];
}

interface PopupResult {
  commandId?: number;
}

function nativeMenu(): { popup: (options: { items: NativeItem[]; x?: number; y?: number }) => Promise<PopupResult> } {
  return (
    window as unknown as {
      glazeAPI: {
        Menu: { popup: (o: { items: NativeItem[]; x?: number; y?: number }) => Promise<PopupResult> };
      };
    }
  ).glazeAPI.Menu;
}

/** Flatten a React node to the plain text a native menu label can hold. */
function textOf(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (React.isValidElement(node)) {
    return textOf((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

/** A walk over the declarative children, assigning each actionable item a
 *  commandId and recording what to run when that id comes back. */
class TemplateBuilder {
  private nextId = 1;
  readonly actions = new Map<number, () => void>();

  build(children: React.ReactNode): NativeItem[] {
    const items: NativeItem[] = [];
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return;
      const type = child.type;
      const props = child.props as Record<string, unknown>;

      if (type === SelectSeparator || type === DropdownMenuSeparator) {
        items.push({ type: "separator" });
        return;
      }
      if (type === SelectLabel || type === DropdownMenuLabel) {
        items.push({ label: textOf(props.children as React.ReactNode), enabled: false });
        return;
      }
      if (type === SelectGroup || type === DropdownMenuGroup) {
        items.push(...this.build(props.children as React.ReactNode));
        return;
      }
      if (type === DropdownMenuSub) {
        items.push({
          label: String(props.label ?? ""),
          enabled: props.disabled !== true,
          submenu: this.build(props.children as React.ReactNode),
        });
        return;
      }
      if (type === SelectItem) {
        const id = this.nextId++;
        const value = String(props.value ?? "");
        items.push({
          label: textOf(props.children as React.ReactNode),
          enabled: props.disabled !== true,
          commandId: id,
        });
        this.actions.set(id, () => (props.__onPick as ((v: string) => void) | undefined)?.(value));
        return;
      }
      if (type === DropdownMenuItem) {
        const id = this.nextId++;
        items.push({
          label: textOf(props.children as React.ReactNode),
          enabled: props.disabled !== true,
          commandId: id,
        });
        this.actions.set(id, () => (props.onSelect as (() => void) | undefined)?.());
        return;
      }
      if (type === DropdownMenuCheckboxItem) {
        const id = this.nextId++;
        const checked = props.checked === true;
        items.push({
          label: textOf(props.children as React.ReactNode),
          enabled: props.disabled !== true,
          checked,
          commandId: id,
        });
        this.actions.set(id, () =>
          (props.onCheckedChange as ((c: boolean) => void) | undefined)?.(!checked),
        );
        return;
      }
      // Fragments and other wrappers: descend.
      if (props.children !== undefined) {
        items.push(...this.build(props.children as React.ReactNode));
      }
    });
    return items;
  }
}

/* ── Select ─────────────────────────────────────────────────────────── */

interface SelectItemProps {
  value: string;
  sublabel?: string;
  icon?: unknown;
  disabled?: boolean;
  children: React.ReactNode;
  /** Injected by Select when building the template. @internal */
  __onPick?: (value: string) => void;
}
export function SelectItem(_props: SelectItemProps): null {
  return null;
}

export function SelectGroup(_props: { children: React.ReactNode }): null {
  return null;
}

export function SelectLabel(_props: { children: React.ReactNode }): null {
  return null;
}

export function SelectSeparator(): null {
  return null;
}

export function SelectContent(_props: { children: React.ReactNode }): null {
  return null;
}

interface SelectContextValue {
  value: string | undefined;
  labelFor: (value: string | undefined) => React.ReactNode;
  disabled: boolean;
  open: (x?: number, y?: number) => void;
}
const SelectContext = React.createContext<SelectContextValue | null>(null);

/** Collect `SelectItem`s from the declarative tree so the trigger can render
 *  the selected item's label without the items ever entering the DOM. */
function collectSelectItems(
  children: React.ReactNode,
  out: Map<string, React.ReactNode> = new Map(),
): Map<string, React.ReactNode> {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    const props = child.props as Record<string, unknown>;
    if (child.type === SelectItem) {
      out.set(String(props.value ?? ""), props.children as React.ReactNode);
      return;
    }
    if (props.children !== undefined) collectSelectItems(props.children as React.ReactNode, out);
  });
  return out;
}

export function Select({
  value,
  defaultValue,
  onValueChange,
  disabled = false,
  children,
}: {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const current = value !== undefined ? value : uncontrolled;

  const content = React.useMemo(() => {
    let found: React.ReactNode = null;
    React.Children.forEach(children, (child) => {
      if (React.isValidElement(child) && child.type === SelectContent) {
        found = (child.props as { children?: React.ReactNode }).children;
      }
    });
    return found;
  }, [children]);

  const labels = React.useMemo(() => collectSelectItems(content), [content]);

  const open = React.useCallback(
    (x?: number, y?: number) => {
      if (disabled) return;
      const builder = new TemplateBuilder();
      // Re-walk with the pick handler injected, and mark the current value.
      const withPick = React.Children.map(content, function inject(
        node: React.ReactNode,
      ): React.ReactNode {
        if (!React.isValidElement(node)) return node;
        const props = node.props as Record<string, unknown>;
        if (node.type === SelectItem) {
          return React.cloneElement(node as React.ReactElement<SelectItemProps>, {
            __onPick: (v: string) => {
              if (value === undefined) setUncontrolled(v);
              onValueChange?.(v);
            },
          });
        }
        if (props.children !== undefined) {
          return React.cloneElement(node as React.ReactElement<{ children?: React.ReactNode }>, {
            children: React.Children.map(props.children as React.ReactNode, inject),
          });
        }
        return node;
      });
      const items = builder.build(withPick).map((item) =>
        item.commandId !== undefined && labels.has(String(item.label)) ? item : item,
      );
      void nativeMenu()
        .popup({ items, x, y })
        .then((res) => {
          if (typeof res?.commandId === "number") builder.actions.get(res.commandId)?.();
        })
        .catch(() => {});
    },
    [content, disabled, labels, onValueChange, value],
  );

  const ctx = React.useMemo<SelectContextValue>(
    () => ({
      value: current,
      labelFor: (v) => (v !== undefined ? (labels.get(v) ?? null) : null),
      disabled,
      open,
    }),
    [current, labels, disabled, open],
  );

  return <SelectContext.Provider value={ctx}>{children}</SelectContext.Provider>;
}

interface SelectTriggerProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "onKeyDown" | "size"> {
  hideChevron?: boolean;
  variant?: "default" | "transparent" | "filled" | "glass";
  size?: "small" | "medium" | "large";
}

export const SelectTrigger = React.forwardRef<HTMLButtonElement, SelectTriggerProps>(
  function SelectTrigger({ className, children, hideChevron, variant, size, ...props }, ref) {
    const ctx = React.useContext(SelectContext);
    return (
      <Button
        ref={ref}
        // `combobox` is the trigger's accessible role: it is a control that
        // opens a list and holds the chosen value. The original design system
        // exposed the same role, and the settings tests find these selects by
        // it — a plain <button> here silently breaks both assistive tech and
        // every `getByRole("combobox")` query.
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={false}
        // Select-trigger vocabulary → Button vocabulary. "default"/"filled" are
        // the trigger's names for the standard bordered control.
        variant={
          variant === "transparent" || variant === "glass" ? variant : variant === "filled" ? "muted" : "primary"
        }
        size={size ?? "medium"}
        disabled={ctx?.disabled}
        className={cn("justify-between gap-1.5 font-normal", className)}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          ctx?.open(Math.round(rect.left), Math.round(rect.bottom));
        }}
        {...props}
      >
        {children}
        {!hideChevron && (
          <svg viewBox="0 0 12 12" className="size-3 shrink-0 opacity-60" aria-hidden>
            <path d="M3 5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        )}
      </Button>
    );
  },
);

export function SelectValue({ placeholder, className }: { placeholder?: string; className?: string }) {
  const ctx = React.useContext(SelectContext);
  const label = ctx?.labelFor(ctx.value);
  return (
    <span className={cn("truncate", !label && "text-muted-foreground", className)}>
      {label ?? placeholder ?? ""}
    </span>
  );
}

/* ── DropdownMenu ───────────────────────────────────────────────────── */

export function DropdownMenuItem(_props: {
  icon?: unknown;
  sublabel?: string;
  accelerator?: string;
  disabled?: boolean;
  color?: string;
  iconColor?: string;
  onSelect?: () => void;
  children: React.ReactNode;
}): null {
  return null;
}

export function DropdownMenuCheckboxItem(_props: {
  icon?: unknown;
  sublabel?: string;
  accelerator?: string;
  disabled?: boolean;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  children: React.ReactNode;
}): null {
  return null;
}

export function DropdownMenuSeparator(): null {
  return null;
}

export function DropdownMenuLabel(_props: { children: React.ReactNode }): null {
  return null;
}

export function DropdownMenuSub(_props: {
  label: string;
  icon?: unknown;
  disabled?: boolean;
  children: React.ReactNode;
}): null {
  return null;
}

export function DropdownMenuGroup(_props: { children: React.ReactNode }): null {
  return null;
}

export function DropdownMenuContent(_props: {
  side?: string;
  align?: string;
  sideOffset?: number;
  alignOffset?: number;
  children: React.ReactNode;
}): null {
  return null;
}
DropdownMenuContent.displayName = "DropdownMenuContent";

interface DropdownMenuContextValue {
  disabled: boolean;
  open: (x?: number, y?: number) => void;
}
const DropdownMenuContext = React.createContext<DropdownMenuContextValue | null>(null);

export function DropdownMenu({
  disabled = false,
  onClose,
  onOpen,
  children,
}: {
  disabled?: boolean;
  onClose?: () => void;
  onOpen?: () => void;
  children: React.ReactNode;
}) {
  const content = React.useMemo(() => {
    let found: React.ReactNode = null;
    React.Children.forEach(children, (child) => {
      if (React.isValidElement(child) && child.type === DropdownMenuContent) {
        found = (child.props as { children?: React.ReactNode }).children;
      }
    });
    return found;
  }, [children]);

  const open = React.useCallback(
    (x?: number, y?: number) => {
      if (disabled) return;
      const builder = new TemplateBuilder();
      const items = builder.build(content);
      onOpen?.();
      void nativeMenu()
        .popup({ items, x, y })
        .then((res) => {
          if (typeof res?.commandId === "number") builder.actions.get(res.commandId)?.();
          onClose?.();
        })
        .catch(() => onClose?.());
    },
    [content, disabled, onClose, onOpen],
  );

  const ctx = React.useMemo<DropdownMenuContextValue>(() => ({ disabled, open }), [disabled, open]);
  return <DropdownMenuContext.Provider value={ctx}>{children}</DropdownMenuContext.Provider>;
}

interface DropdownMenuTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
}

export const DropdownMenuTrigger = React.forwardRef<HTMLButtonElement, DropdownMenuTriggerProps>(
  function DropdownMenuTrigger({ asChild, children, onClick, ...props }, ref) {
    const ctx = React.useContext(DropdownMenuContext);
    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      const rect = e.currentTarget.getBoundingClientRect();
      ctx?.open(Math.round(rect.left), Math.round(rect.bottom));
    };
    if (asChild && React.isValidElement(children)) {
      return React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        ref,
        onClick: handleClick,
        disabled: ctx?.disabled,
      });
    }
    return (
      <button ref={ref} type="button" disabled={ctx?.disabled} onClick={handleClick} {...props}>
        {children}
      </button>
    );
  },
);

export type NativeMenuIcon = string;
export type DropdownMenuSide = "top" | "right" | "bottom" | "left";
export type DropdownMenuAlign = "start" | "center" | "end";
