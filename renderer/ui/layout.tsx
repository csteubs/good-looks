// Structural components: Toolbar family, composite ScrollArea, Field family,
// Callout, EmptyState, Sidebar family, SplitView, ErrorBoundaryView.

import * as React from "react";
import { ScrollArea as ScrollAreaPrimitive, Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronLeft, PanelLeft, X } from "lucide-react";

import { cn } from "./cn";
import { Button, Label, Text, type ButtonProps, type BadgeColor } from "./primitives";

/* ── Toolbar ────────────────────────────────────────────────────────── */

export interface ToolbarProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
  position?: "top" | "bottom";
  inset?: "none" | "windowControls" | "windowControlsAndButton";
  background?: "progressive-blur" | "full-blur";
  disableLayoutTransition?: boolean;
}

export function Toolbar({
  children,
  className,
  position = "top",
  inset,
  background: _background,
  disableLayoutTransition: _dlt,
  ...props
}: ToolbarProps) {
  return (
    <div
      data-toolbar
      className={cn(
        "drag-region sticky z-20 flex min-h-13 shrink-0 flex-col justify-center gap-1 border-b border-border/50 bg-background/80 px-4 py-2 backdrop-blur",
        position === "top" ? "top-0" : "bottom-0 border-t border-b-0",
        // Clear the macOS traffic lights when this toolbar owns the top edge.
        inset !== "none" && position === "top" && "window-controls-inset",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function ToolbarRow({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex w-full items-center gap-2", className)} {...props}>
      {children}
    </div>
  );
}

export function ToolbarContent({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex min-w-0 flex-1 flex-col justify-center", className)} {...props}>
      {children}
    </div>
  );
}

export function ToolbarTitle({ children, className, ...props }: Omit<React.ComponentProps<"h2">, "color">) {
  return (
    <h2 className={cn("truncate text-[13px] font-semibold text-foreground", className)} {...props}>
      {children}
    </h2>
  );
}

export function ToolbarDescription({ children, className, ...props }: Omit<React.ComponentProps<"p">, "color">) {
  return (
    <p className={cn("truncate text-xs text-muted-foreground", className)} {...props}>
      {children}
    </p>
  );
}

export function ToolbarActions({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex shrink-0 items-center gap-1.5", className)} {...props}>
      {children}
    </div>
  );
}

export interface ToolbarBackButtonProps extends Omit<ButtonProps, "children" | "iconOnly"> {
  label?: string;
}

export function ToolbarBackButton({ label = "Back", variant, size, ...props }: ToolbarBackButtonProps) {
  return (
    <Button
      iconOnly
      aria-label={label}
      variant={variant ?? "glass"}
      size={size ?? "medium"}
      {...props}
    >
      <ChevronLeft className="size-4" />
    </Button>
  );
}

/* ── ScrollArea (composite: optional auto-toolbar + auto-follow) ───── */

export type ScrollAreaControl = {
  forceScrollToBottom: () => void;
  suspendAutoFollow: () => void;
  resumeAutoFollow: () => void;
};

type ScrollAreaProps = {
  toolbar?: React.ReactNode;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  leading?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  viewportClassName?: string;
  fadeEdges?: boolean;
  autoScrollToBottom?: boolean;
  autoScrollDeps?: React.DependencyList;
  showScrollToBottomButton?: boolean;
  scrollbars?: "vertical" | "horizontal" | "both";
  scrollbarBottomOffset?: number;
  scrollbarTopOffset?: number;
  scrollControlRef?: React.MutableRefObject<ScrollAreaControl | null>;
} & Omit<React.ComponentProps<typeof ScrollAreaPrimitive.Root>, "title">;

export const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  {
    toolbar,
    title,
    subtitle,
    actions,
    leading,
    footer,
    children,
    className,
    viewportClassName,
    fadeEdges: _fadeEdges,
    autoScrollToBottom,
    autoScrollDeps,
    showScrollToBottomButton: _sstb,
    scrollbars = "vertical",
    scrollbarBottomOffset: _sbo,
    scrollbarTopOffset: _sto,
    scrollControlRef,
    ...props
  },
  ref,
) {
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  // Follow-bottom: keep pinned to the end while the user hasn't scrolled away.
  // A wheel/scroll that leaves the bottom releases the pin; returning re-arms it.
  const followRef = React.useRef(true);
  const suspendedRef = React.useRef(0);

  const scrollToBottom = React.useCallback(() => {
    const vp = viewportRef.current;
    if (vp) vp.scrollTop = vp.scrollHeight;
    followRef.current = true;
  }, []);

  React.useEffect(() => {
    if (scrollControlRef) {
      scrollControlRef.current = {
        forceScrollToBottom: scrollToBottom,
        suspendAutoFollow: () => {
          suspendedRef.current++;
        },
        resumeAutoFollow: () => {
          suspendedRef.current = Math.max(0, suspendedRef.current - 1);
        },
      };
      return () => {
        scrollControlRef.current = null;
      };
    }
  }, [scrollControlRef, scrollToBottom]);

  // Auto-follow on content growth. Deps are caller-declared, matching the
  // original contract (autoScrollDeps), so growth the caller cares about —
  // e.g. lines.length — triggers the scroll.
  // Deps are caller-supplied by design (the `autoScrollDeps` prop), so this
  // effect's dependency list is intentionally dynamic.
  React.useEffect(() => {
    if (!autoScrollToBottom || suspendedRef.current > 0) return;
    if (followRef.current) scrollToBottom();
  }, autoScrollDeps ?? [children]);

  const onScroll = React.useCallback(() => {
    const vp = viewportRef.current;
    if (!vp || suspendedRef.current > 0) return;
    followRef.current = vp.scrollHeight - vp.scrollTop - vp.clientHeight < 24;
  }, []);

  const autoToolbar =
    toolbar ??
    (title || subtitle || actions || leading ? (
      <Toolbar>
        <ToolbarRow>
          {leading}
          <ToolbarContent>
            {title && <ToolbarTitle>{title}</ToolbarTitle>}
            {subtitle && <ToolbarDescription>{subtitle}</ToolbarDescription>}
          </ToolbarContent>
          {actions && <ToolbarActions>{actions}</ToolbarActions>}
        </ToolbarRow>
      </Toolbar>
    ) : null);

  return (
    <ScrollAreaPrimitive.Root
      ref={ref}
      className={cn("relative flex h-full flex-col overflow-hidden", className)}
      {...props}
    >
      {autoToolbar}
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        onScroll={autoScrollToBottom ? onScroll : undefined}
        className={cn("w-full flex-1 rounded-[inherit] [&>div]:!block", viewportClassName)}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {footer}
      {(scrollbars === "vertical" || scrollbars === "both") && (
        <ScrollAreaPrimitive.Scrollbar
          orientation="vertical"
          className="z-30 flex w-2.5 touch-none p-0.5 select-none"
        >
          <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-foreground/25" />
        </ScrollAreaPrimitive.Scrollbar>
      )}
      {(scrollbars === "horizontal" || scrollbars === "both") && (
        <ScrollAreaPrimitive.Scrollbar
          orientation="horizontal"
          className="z-30 flex h-2.5 touch-none flex-col p-0.5 select-none"
        >
          <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-foreground/25" />
        </ScrollAreaPrimitive.Scrollbar>
      )}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
});

/* ── Field family ───────────────────────────────────────────────────── */

export function FieldSet({
  className,
  title,
  description,
  children,
  ...props
}: Omit<React.ComponentProps<"fieldset">, "title"> & {
  title?: React.ReactNode;
  description?: React.ReactNode;
}) {
  const hasGroup = React.Children.toArray(children).some(
    (child) => React.isValidElement(child) && child.type === FieldGroup,
  );
  return (
    <fieldset className={cn("flex min-w-0 flex-col gap-2", className)} {...props}>
      {title && <FieldLegend>{title}</FieldLegend>}
      {description && <FieldDescription>{description}</FieldDescription>}
      {hasGroup || !title ? children : <FieldGroup>{children}</FieldGroup>}
    </fieldset>
  );
}
FieldSet.displayName = "FieldSet";

export function FieldLegend({
  className,
  variant: _variant,
  ...props
}: Omit<React.ComponentProps<"legend">, "color"> & { variant?: "legend" | "label" }) {
  return (
    <legend
      className={cn("mb-1 px-0.5 text-[13px] font-semibold text-foreground", className)}
      {...props}
    />
  );
}
FieldLegend.displayName = "FieldLegend";

export function FieldGroup({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border border-border/60 bg-muted/40 px-3 [&>*+*]:border-t [&>*+*]:border-border/50",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
FieldGroup.displayName = "FieldGroup";

const fieldVariants = cva("flex min-w-0 gap-2 py-2.5", {
  variants: {
    orientation: {
      horizontal: "flex-row items-center justify-between",
      vertical: "flex-col items-stretch",
      responsive: "flex-col items-stretch sm:flex-row sm:items-center sm:justify-between",
    },
  },
  defaultVariants: { orientation: "vertical" },
});

export function Field({
  className,
  orientation,
  label,
  description,
  error,
  children,
  onClick,
  disabled,
  ref,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof fieldVariants> & {
    label?: React.ReactNode;
    description?: React.ReactNode;
    error?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLElement>;
    disabled?: boolean;
    ref?: React.Ref<HTMLElement>;
  }) {
  const effectiveOrientation = orientation ?? (label ? "horizontal" : "vertical");
  const body = label ? (
    <>
      <FieldContent>
        <FieldLabel>{label}</FieldLabel>
        {description && <FieldDescription>{description}</FieldDescription>}
      </FieldContent>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{children}</div>
    </>
  ) : (
    children
  );
  if (onClick) {
    return (
      <button
        ref={ref as React.Ref<HTMLButtonElement>}
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          fieldVariants({ orientation: effectiveOrientation }),
          "w-full text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50",
          className,
        )}
        {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
      >
        {body}
        {error && <FieldError>{error}</FieldError>}
      </button>
    );
  }
  return (
    <div
      ref={ref as React.Ref<HTMLDivElement>}
      className={cn(fieldVariants({ orientation: effectiveOrientation }), className)}
      {...props}
    >
      {body}
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}
Field.displayName = "Field";

export function FieldContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5", className)} {...props} />;
}
FieldContent.displayName = "FieldContent";

export function FieldLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
  return <Label className={cn("text-[13px]", className)} {...props} />;
}
FieldLabel.displayName = "FieldLabel";

export function FieldTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("text-[13px] font-medium", className)} {...props} />;
}
FieldTitle.displayName = "FieldTitle";

export function FieldDescription({ className, ...props }: Omit<React.ComponentProps<"p">, "color">) {
  return <p className={cn("text-xs text-muted-foreground", className)} {...props} />;
}
FieldDescription.displayName = "FieldDescription";

export function FieldSeparator({ children, className, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("relative my-1 h-px bg-border", className)} {...props}>
      {children && (
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-2 text-xs text-muted-foreground">
          {children}
        </span>
      )}
    </div>
  );
}
FieldSeparator.displayName = "FieldSeparator";

export function FieldError({
  className,
  children,
  errors,
  ...props
}: React.ComponentProps<"div"> & { errors?: Array<{ message?: string } | undefined> }) {
  const content =
    children ??
    errors
      ?.map((e) => e?.message)
      .filter(Boolean)
      .join(", ");
  if (!content) return null;
  return (
    <div className={cn("text-xs text-destructive", className)} {...props}>
      {content}
    </div>
  );
}
FieldError.displayName = "FieldError";

/* ── Callout ────────────────────────────────────────────────────────── */

const calloutColorClass: Record<BadgeColor, string> = {
  primary: "bg-accent/10 border-accent/30 text-foreground",
  secondary: "bg-muted/60 border-border/60 text-foreground",
  blue: "bg-blue-500/10 border-blue-500/30",
  green: "bg-green-500/10 border-green-500/30",
  yellow: "bg-yellow-500/10 border-yellow-500/30",
  orange: "bg-orange-500/10 border-orange-500/30",
  red: "bg-red-500/10 border-red-500/30",
  purple: "bg-purple-500/10 border-purple-500/30",
  magenta: "bg-pink-500/10 border-pink-500/30",
};

export interface CalloutProps extends Omit<React.ComponentProps<"div">, "color"> {
  color?: BadgeColor;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}

function CalloutRoot({
  className,
  color = "secondary",
  icon,
  actions,
  onDismiss,
  dismissLabel = "Dismiss",
  children,
  ...props
}: CalloutProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px]",
        calloutColorClass[color] ?? calloutColorClass.secondary,
        className,
      )}
      {...props}
    >
      {icon && <CalloutIcon>{icon}</CalloutIcon>}
      <div className="min-w-0 flex-1">{children}</div>
      {actions && <CalloutActions>{actions}</CalloutActions>}
      {onDismiss && <CalloutClose label={dismissLabel} onClick={onDismiss} />}
    </div>
  );
}
CalloutRoot.displayName = "Callout";

function CalloutIcon({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mt-0.5 shrink-0 [&_svg]:size-4", className)} {...props} />;
}
CalloutIcon.displayName = "CalloutIcon";

function CalloutText({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-[13px] leading-snug", className)} {...props} />;
}
CalloutText.displayName = "CalloutText";

function CalloutActions({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex shrink-0 items-center gap-1.5", className)} {...props} />;
}
CalloutActions.displayName = "CalloutActions";

function CalloutClose({
  className,
  label = "Dismiss",
  "aria-label": ariaLabel,
  ...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { label?: string }) {
  return (
    <button
      type="button"
      aria-label={ariaLabel ?? label}
      className={cn(
        "shrink-0 rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
      {...props}
    >
      <X className="size-3.5" />
    </button>
  );
}
CalloutClose.displayName = "CalloutClose";

export const Callout = Object.assign(CalloutRoot, {
  Icon: CalloutIcon,
  Text: CalloutText,
  Actions: CalloutActions,
  Close: CalloutClose,
});

/* ── EmptyState ─────────────────────────────────────────────────────── */

export function EmptyStateMedia({ children, className, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("mb-1 text-muted-foreground [&_svg]:size-8", className)} {...props}>
      {children}
    </div>
  );
}

export function EmptyStateTitle({ children, className, ...props }: Omit<React.ComponentProps<"h1">, "color">) {
  return (
    <h1 className={cn("text-sm font-semibold text-foreground", className)} {...props}>
      {children}
    </h1>
  );
}

export function EmptyStateDescription({ children, className, ...props }: Omit<React.ComponentProps<"p">, "color">) {
  return (
    <p className={cn("max-w-96 text-center text-xs text-muted-foreground", className)} {...props}>
      {children}
    </p>
  );
}

export function EmptyStateActions({ children, className, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("mt-2 flex items-center gap-2", className)} {...props}>
      {children}
    </div>
  );
}

export function EmptyState({
  children,
  className,
  placement = "center",
  title,
  description,
  actions,
  media,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  placement?: "center" | "inline";
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  media?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 p-6",
        placement === "center" && "h-full",
        className,
      )}
      {...props}
    >
      {media && <EmptyStateMedia>{media}</EmptyStateMedia>}
      {title && <EmptyStateTitle>{title}</EmptyStateTitle>}
      {description && <EmptyStateDescription>{description}</EmptyStateDescription>}
      {actions && <EmptyStateActions>{actions}</EmptyStateActions>}
      {children}
    </div>
  );
}

/* ── ErrorBoundaryView ──────────────────────────────────────────────── */

export function ErrorBoundaryView({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  return (
    <EmptyState
      title="Something went wrong"
      description={
        <>
          <span className="block">{message}</span>
          <span className="mt-1 block">Reload the window to continue (View → Reload).</span>
        </>
      }
    />
  );
}

/* ── Sidebar family ─────────────────────────────────────────────────── */

interface SidebarProps {
  children: React.ReactNode;
  className?: string;
  toolbar?: React.ReactNode;
  footer?: React.ReactNode;
  scrollEnabled?: boolean;
  actions?: React.ReactNode;
  searchable?: boolean;
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
}

export function Sidebar({
  children,
  className,
  toolbar,
  footer,
  scrollEnabled = true,
  actions,
  searchable,
  searchPlaceholder = "Search",
  searchValue,
  onSearchChange,
}: SidebarProps) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-muted/30", className)}>
      {toolbar ?? (
        <div className="drag-region window-controls-inset flex min-h-13 shrink-0 items-center justify-end gap-1 px-3 pt-1">
          {actions}
        </div>
      )}
      {searchable && (
        <div className="px-3 pb-2">
          <input
            type="search"
            placeholder={searchPlaceholder}
            value={searchValue}
            onChange={(e) => onSearchChange?.(e.target.value)}
            className="h-6 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </div>
      )}
      <div className={cn("min-h-0 flex-1 px-2 pb-2", scrollEnabled && "overflow-y-auto")}>
        {children}
      </div>
      {footer}
    </div>
  );
}
Sidebar.displayName = "Sidebar";

type SidebarListContextValue = {
  selectedKey: string | null;
  onSelect: ((item: unknown) => void) | null;
  getKey: ((item: unknown) => string) | null;
};
const SidebarListContext = React.createContext<SidebarListContextValue>({
  selectedKey: null,
  onSelect: null,
  getKey: null,
});

export function SidebarList<T>({
  children,
  className,
  items,
  selectedItem,
  onSelectedItemChange,
  getItemKey,
  emptyState,
}: {
  children: React.ReactNode;
  className?: string;
  items?: T[];
  selectedItem?: T | null;
  onSelectedItemChange?: (item: T) => void;
  getItemKey?: (item: T) => string;
  emptyState?: React.ReactNode;
}) {
  const ctx = React.useMemo<SidebarListContextValue>(
    () => ({
      selectedKey:
        selectedItem != null && getItemKey ? getItemKey(selectedItem) : null,
      onSelect: onSelectedItemChange as ((item: unknown) => void) | null,
      getKey: getItemKey as ((item: unknown) => string) | null,
    }),
    [selectedItem, onSelectedItemChange, getItemKey],
  );
  if (items && items.length === 0 && emptyState) return <>{emptyState}</>;
  return (
    <SidebarListContext.Provider value={ctx}>
      <div className={cn("flex flex-col gap-px", className)}>{children}</div>
    </SidebarListContext.Provider>
  );
}

export function SidebarListGroup({
  children,
  className,
  title,
  actions,
  collapsible: _collapsible,
  defaultOpen: _defaultOpen,
  open: _open,
  onOpenChange: _onOpenChange,
  forceOpen: _forceOpen,
}: {
  children?: React.ReactNode;
  className?: string;
  title?: React.ReactNode;
  actions?: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  forceOpen?: boolean;
}) {
  return (
    <div className={cn("flex flex-col gap-px pt-3 first:pt-0", className)}>
      {title && (
        <div className="flex items-center justify-between px-2 pb-1">
          <SidebarListGroupTitle>{title}</SidebarListGroupTitle>
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

export function SidebarListGroupTitle({
  children,
  asChild,
  className,
}: {
  children: React.ReactNode;
  asChild?: boolean;
  className?: string;
}) {
  const Comp = asChild ? Slot.Root : "h2";
  return (
    <Comp className={cn("text-[11px] font-semibold text-muted-foreground", className)}>
      {children}
    </Comp>
  );
}

export function SidebarListItem<T>({
  children,
  onClick,
  selected,
  className,
  item,
  icon,
  title,
  subtitle,
  accessory,
  collapsible: _collapsible,
  defaultOpen: _dO,
  open: _o,
  onOpenChange: _oc,
  forceOpen: _fo,
  ...props
}: Omit<React.ComponentProps<"button">, "onClick" | "title"> & {
  children?: React.ReactNode;
  onClick?: () => void;
  selected?: boolean;
  className?: string;
  item?: T;
  icon?: React.ReactNode;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  accessory?: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  forceOpen?: boolean;
}) {
  const ctx = React.useContext(SidebarListContext);
  const managedSelected =
    item !== undefined && ctx.getKey && ctx.selectedKey !== null
      ? ctx.getKey(item) === ctx.selectedKey
      : undefined;
  const isSelected = managedSelected ?? selected ?? false;
  const handleActivate = () => {
    if (item !== undefined && ctx.onSelect) ctx.onSelect(item);
    onClick?.();
  };
  return (
    <button
      type="button"
      // MOUSE-DOWN, not click — the same native-macOS idiom AppKit lists use,
      // and what the SDK's own component did. The rebuild originally used
      // onClick; nothing in-tree noticed until the settings redesign arrived
      // with tests that drive rows the way the real component behaves, and
      // then reported "0 calls", which reads as a dead handler rather than as
      // the wrong event.
      onMouseDown={handleActivate}
      data-selected={isSelected || undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/50",
        // `bg-list-selection`, not `bg-selection`: the latter was invented by
        // the rebuild and is not in the theme bridge, so it compiled to
        // NOTHING and a selected row had no highlight at all.
        isSelected && "bg-list-selection text-foreground hover:bg-list-selection",
        className,
      )}
      {...props}
    >
      {icon && <span className="flex shrink-0 items-center [&_svg]:size-4 [&_img]:size-4">{icon}</span>}
      {title !== undefined ? (
        <>
          <SidebarListItemContent>
            <SidebarListItemTitle truncate>{title}</SidebarListItemTitle>
            {subtitle && <SidebarListItemSubtitle>{subtitle}</SidebarListItemSubtitle>}
          </SidebarListItemContent>
          {accessory !== undefined &&
            (typeof accessory === "string" || typeof accessory === "number" ? (
              <SidebarListItemAccessory>{accessory}</SidebarListItemAccessory>
            ) : (
              accessory
            ))}
        </>
      ) : (
        children
      )}
    </button>
  );
}
SidebarListItem.displayName = "SidebarListItem";

export function SidebarListItemContent({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("flex min-w-0 flex-1 flex-col", className)} {...props} />;
}

export function SidebarListItemTitle({ className, ...props }: React.ComponentProps<typeof Text>) {
  return <Text variant="regular" truncate className={cn("leading-tight", className)} {...props} />;
}

export function SidebarListItemSubtitle({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("truncate text-[11px] text-muted-foreground", className)} {...props} />;
}

export function SidebarListItemAccessory({ className, children, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground", className)}
      {...props}
    >
      {children}
    </span>
  );
}

export function SidebarFooter({ children, className }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("shrink-0 border-t border-border/50 px-3 py-2", className)}>{children}</div>
  );
}

/* ── SplitView ──────────────────────────────────────────────────────── */

type SlotSize = { default?: number; min?: number; max?: number };

type SplitViewContextValue = {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  inspectorCollapsed: boolean;
  toggleInspector: () => void;
};
const SplitViewContext = React.createContext<SplitViewContextValue | null>(null);

export function useSplitView(): SplitViewContextValue {
  const ctx = React.useContext(SplitViewContext);
  if (!ctx) throw new Error("useSplitView must be used within a SplitView");
  return ctx;
}

function readStored(key: string | undefined, suffix: string): number | boolean | null {
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(`splitview:${key}:${suffix}`);
    return raw === null ? null : (JSON.parse(raw) as number | boolean);
  } catch {
    return null;
  }
}

function writeStored(key: string | undefined, suffix: string, value: number | boolean): void {
  if (!key) return;
  try {
    window.localStorage.setItem(`splitview:${key}:${suffix}`, JSON.stringify(value));
  } catch {
    /* persistence is best-effort */
  }
}

type SplitViewProps = {
  sidebar?: React.ReactNode;
  sidebarSize?: SlotSize;
  sidebarCollapsed?: boolean;
  defaultSidebarCollapsed?: boolean;
  onSidebarCollapsedChange?: (collapsed: boolean) => void;
  list?: React.ReactNode;
  listSize?: SlotSize;
  children: React.ReactNode;
  primarySize?: Pick<SlotSize, "min">;
  inspector?: React.ReactNode;
  inspectorSize?: SlotSize;
  inspectorCollapsed?: boolean;
  defaultInspectorCollapsed?: boolean;
  onInspectorCollapsedChange?: (collapsed: boolean) => void;
  storageKey?: string;
  className?: string;
};

/** Resizable column between panes. Pointer-based so it needs no library. */
function ResizeHandle({
  onDelta,
  onDone,
}: {
  onDelta: (deltaPx: number) => void;
  onDone: () => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className="relative z-10 -mx-0.75 w-1.5 shrink-0 cursor-col-resize select-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border/70 hover:after:bg-ring/60"
      onPointerDown={(down) => {
        down.preventDefault();
        const startX = down.clientX;
        const target = down.currentTarget;
        target.setPointerCapture(down.pointerId);
        const move = (e: PointerEvent) => onDelta(e.clientX - startX);
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          onDone();
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    />
  );
}

function SplitViewRoot({
  sidebar,
  sidebarSize,
  sidebarCollapsed: sidebarCollapsedProp,
  defaultSidebarCollapsed,
  onSidebarCollapsedChange,
  list,
  listSize,
  children,
  primarySize,
  inspector,
  inspectorSize,
  inspectorCollapsed: inspectorCollapsedProp,
  defaultInspectorCollapsed,
  onInspectorCollapsedChange,
  storageKey,
  className,
}: SplitViewProps) {
  const [sidebarWidth, setSidebarWidth] = React.useState<number>(
    () =>
      (readStored(storageKey, "sidebar-width") as number | null) ??
      sidebarSize?.default ??
      240,
  );
  const [listWidth, setListWidth] = React.useState<number>(
    () => (readStored(storageKey, "list-width") as number | null) ?? listSize?.default ?? 260,
  );
  const [inspectorWidth, setInspectorWidth] = React.useState<number>(
    () =>
      (readStored(storageKey, "inspector-width") as number | null) ??
      inspectorSize?.default ??
      280,
  );

  const [sidebarCollapsedState, setSidebarCollapsedState] = React.useState<boolean>(
    () =>
      (readStored(storageKey, "sidebar-collapsed") as boolean | null) ??
      defaultSidebarCollapsed ??
      false,
  );
  const sidebarCollapsed = sidebarCollapsedProp ?? sidebarCollapsedState;
  const [inspectorCollapsedState, setInspectorCollapsedState] = React.useState<boolean>(
    () =>
      (readStored(storageKey, "inspector-collapsed") as boolean | null) ??
      defaultInspectorCollapsed ??
      false,
  );
  const inspectorCollapsed = inspectorCollapsedProp ?? inspectorCollapsedState;

  const clamp = (value: number, size?: SlotSize) =>
    Math.min(size?.max ?? 480, Math.max(size?.min ?? 160, value));

  const sidebarStartRef = React.useRef(sidebarWidth);
  const listStartRef = React.useRef(listWidth);
  const inspectorStartRef = React.useRef(inspectorWidth);

  const toggleSidebar = React.useCallback(() => {
    const next = !sidebarCollapsed;
    setSidebarCollapsedState(next);
    writeStored(storageKey, "sidebar-collapsed", next);
    onSidebarCollapsedChange?.(next);
  }, [sidebarCollapsed, storageKey, onSidebarCollapsedChange]);

  const toggleInspector = React.useCallback(() => {
    const next = !inspectorCollapsed;
    setInspectorCollapsedState(next);
    writeStored(storageKey, "inspector-collapsed", next);
    onInspectorCollapsedChange?.(next);
  }, [inspectorCollapsed, storageKey, onInspectorCollapsedChange]);

  // ⌃⌘S mirrors the original's sidebar shortcut.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.metaKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        toggleSidebar();
      }
      if (e.ctrlKey && e.metaKey && (e.key === "i" || e.key === "I") && inspector) {
        e.preventDefault();
        toggleInspector();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar, toggleInspector, inspector]);

  const ctx = React.useMemo<SplitViewContextValue>(
    () => ({ sidebarCollapsed, toggleSidebar, inspectorCollapsed, toggleInspector }),
    [sidebarCollapsed, toggleSidebar, inspectorCollapsed, toggleInspector],
  );

  return (
    <SplitViewContext.Provider value={ctx}>
      <div className={cn("flex h-full min-h-0 w-full overflow-hidden", className)}>
        {sidebar && !sidebarCollapsed && (
          <>
            <div style={{ width: sidebarWidth }} className="h-full shrink-0 overflow-hidden">
              {sidebar}
            </div>
            <ResizeHandle
              onDelta={(d) => setSidebarWidth(clamp(sidebarStartRef.current + d, sidebarSize))}
              onDone={() => {
                sidebarStartRef.current = sidebarWidth;
                writeStored(storageKey, "sidebar-width", sidebarWidth);
              }}
            />
          </>
        )}
        {list && (
          <>
            <div style={{ width: listWidth }} className="h-full shrink-0 overflow-hidden">
              {list}
            </div>
            <ResizeHandle
              onDelta={(d) => setListWidth(clamp(listStartRef.current + d, listSize))}
              onDone={() => {
                listStartRef.current = listWidth;
                writeStored(storageKey, "list-width", listWidth);
              }}
            />
          </>
        )}
        <div
          className="relative h-full min-w-0 flex-1"
          style={primarySize?.min ? { minWidth: primarySize.min } : undefined}
        >
          {children}
        </div>
        {inspector && !inspectorCollapsed && (
          <>
            <ResizeHandle
              onDelta={(d) =>
                setInspectorWidth(clamp(inspectorStartRef.current - d, inspectorSize))
              }
              onDone={() => {
                inspectorStartRef.current = inspectorWidth;
                writeStored(storageKey, "inspector-width", inspectorWidth);
              }}
            />
            <div style={{ width: inspectorWidth }} className="h-full shrink-0 overflow-hidden">
              {inspector}
            </div>
          </>
        )}
      </div>
    </SplitViewContext.Provider>
  );
}

type ToggleButtonProps = Omit<ButtonProps, "aria-label" | "aria-pressed" | "children" | "onClick"> & {
  "aria-label"?: string;
  children?: React.ReactNode;
  pinned?: boolean;
};

const SidebarToggle = React.forwardRef<HTMLButtonElement, ToggleButtonProps>(function SidebarToggle(
  { "aria-label": ariaLabel = "Toggle sidebar", children, pinned: _pinned, className, ...props },
  ref,
) {
  const { sidebarCollapsed, toggleSidebar } = useSplitView();
  return (
    <Button
      ref={ref}
      iconOnly
      variant="transparent"
      size="medium"
      aria-label={ariaLabel}
      aria-pressed={!sidebarCollapsed}
      onClick={toggleSidebar}
      className={cn(
        // Pinned: fixed at the frame's leading edge, clear of the traffic lights.
        "absolute left-2 top-2 z-30",
        className,
      )}
      {...props}
    >
      {children ?? <PanelLeft className="size-4" />}
    </Button>
  );
});

const InspectorToggle = React.forwardRef<HTMLButtonElement, ToggleButtonProps>(
  function InspectorToggle(
    { "aria-label": ariaLabel = "Toggle inspector", children, pinned: _pinned, className, ...props },
    ref,
  ) {
    const { inspectorCollapsed, toggleInspector } = useSplitView();
    return (
      <Button
        ref={ref}
        iconOnly
        variant="transparent"
        size="medium"
        aria-label={ariaLabel}
        aria-pressed={!inspectorCollapsed}
        onClick={toggleInspector}
        className={cn("absolute right-2 top-2 z-30", className)}
        {...props}
      >
        {children ?? <PanelLeft className="size-4 rotate-180" />}
      </Button>
    );
  },
);

export const SplitView = Object.assign(SplitViewRoot, {
  SidebarToggle,
  InspectorToggle,
});
export type { SplitViewProps, SlotSize };
