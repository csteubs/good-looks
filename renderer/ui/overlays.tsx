// Portalled overlays: Dialog, AlertDialog, CustomContextMenu (Radix DOM
// context menu — distinct from the native menus in native-menu.tsx), the
// Toaster and its `toast` API, and the DOM date picker.

import * as React from "react";
import {
  AlertDialog as AlertDialogPrimitive,
  ContextMenu as ContextMenuPrimitive,
  Dialog as DialogPrimitive,
} from "radix-ui";
import { Toaster as SonnerToaster, toast as sonnerToast } from "sonner";
import { X } from "lucide-react";

import { cn } from "./cn";
import { Button, type ButtonProps } from "./primitives";

/* ── Shared sizing ──────────────────────────────────────────────────── */

type DialogSize = "small" | "medium" | "large" | "xl" | "2xl";
const dialogSizeClass: Record<DialogSize, string> = {
  small: "max-w-sm",
  medium: "max-w-md",
  large: "max-w-lg",
  xl: "max-w-2xl",
  "2xl": "max-w-4xl",
};

/* ── Dialog ─────────────────────────────────────────────────────────── */

type SideAction = { label: React.ReactNode; onClick: () => void | Promise<void> };

export function DialogTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger {...props} />;
}
DialogTrigger.displayName = "DialogTrigger";

export function DialogPortal(props: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal {...props} />;
}

export function DialogClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close {...props} />;
}

export function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        "fixed inset-0 z-50 bg-[var(--overlay)] data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

export function DialogContent({
  className,
  children,
  showCloseButton = true,
  overlayClassName,
  size = "medium",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  overlayClassName?: string;
  size?: DialogSize;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-4rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4 shadow-2xl outline-none",
          dialogSizeClass[size],
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            aria-label="Close"
            className="absolute right-3 top-3 rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1 pr-6", className)} {...props} />;
}

export function DialogBody({
  className,
  scrollAreaClassName,
  maxHeight,
  ...props
}: React.ComponentProps<"div"> & { scrollAreaClassName?: string; maxHeight?: string }) {
  return (
    <div
      className={cn("min-h-0 flex-1 overflow-y-auto", scrollAreaClassName, className)}
      style={maxHeight ? { maxHeight } : undefined}
      {...props}
    />
  );
}

export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex items-center justify-end gap-2 pt-1", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("text-[13px] font-semibold", className)} {...props} />;
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description className={cn("text-xs text-muted-foreground", className)} {...props} />
  );
}

type DialogOwnProps = {
  trigger?: React.ReactNode;
  title?: React.ReactNode;
  hideTitle?: boolean;
  description?: React.ReactNode;
  hideDescription?: boolean;
  onConfirm?: () => void | Promise<void>;
  confirmLabel?: React.ReactNode;
  confirmVariant?: "accent" | "destructive";
  confirmDisabled?: boolean;
  destructiveAction?: SideAction;
  secondaryAction?: SideAction;
  size?: DialogSize;
  showCloseButton?: boolean;
  showOverlay?: boolean;
};

/** Screen-reader-only, so Radix's required Title/Description are always present
 *  even when the caller asks to hide them. */
const srOnly = "absolute size-px overflow-hidden whitespace-nowrap [clip:rect(0,0,0,0)]";

export function Dialog({
  children,
  showOverlay: _showOverlay,
  trigger,
  title,
  hideTitle,
  description,
  hideDescription,
  onConfirm,
  confirmLabel = "Done",
  confirmVariant = "accent",
  confirmDisabled,
  destructiveAction,
  secondaryAction,
  size,
  showCloseButton,
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root> & DialogOwnProps) {
  const composed =
    trigger !== undefined ||
    title !== undefined ||
    description !== undefined ||
    onConfirm !== undefined;

  if (!composed) {
    return (
      <DialogPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange} {...props}>
        {children}
      </DialogPrimitive.Root>
    );
  }

  return (
    <DialogPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange} {...props}>
      {trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
      <DialogContent size={size} showCloseButton={showCloseButton}>
        <DialogHeader>
          <DialogTitle className={hideTitle ? srOnly : undefined}>{title ?? ""}</DialogTitle>
          {description !== undefined && (
            <DialogDescription className={hideDescription ? srOnly : undefined}>
              {description}
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogBody>{children}</DialogBody>
        {onConfirm && (
          <DialogFooter>
            {destructiveAction && (
              <Button variant="destructive" className="mr-auto" onClick={() => void destructiveAction.onClick()}>
                {destructiveAction.label}
              </Button>
            )}
            {secondaryAction && (
              <Button
                variant="muted"
                className={destructiveAction ? undefined : "mr-auto"}
                onClick={() => void secondaryAction.onClick()}
              >
                {secondaryAction.label}
              </Button>
            )}
            <DialogPrimitive.Close asChild>
              <Button variant="muted">Cancel</Button>
            </DialogPrimitive.Close>
            <Button
              variant={confirmVariant}
              disabled={confirmDisabled}
              onClick={() => void onConfirm()}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </DialogPrimitive.Root>
  );
}
Dialog.displayName = "Dialog";

/* ── AlertDialog ────────────────────────────────────────────────────── */

export function AlertDialogTrigger(props: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return <AlertDialogPrimitive.Trigger {...props} />;
}
AlertDialogTrigger.displayName = "AlertDialogTrigger";

export function AlertDialogPortal(props: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return <AlertDialogPrimitive.Portal {...props} />;
}

export function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return <AlertDialogPrimitive.Overlay className={cn("fixed inset-0 z-50 bg-[var(--overlay)]", className)} {...props} />;
}

export function AlertDialogContent({
  className,
  children,
  size = "small",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> & { size?: DialogSize }) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 flex w-[calc(100vw-4rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4 text-center shadow-2xl outline-none",
          dialogSizeClass[size],
          className,
        )}
        {...props}
      >
        {children}
      </AlertDialogPrimitive.Content>
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1", className)} {...props} />;
}

export function AlertDialogBody({
  className,
  scrollAreaClassName,
  ...props
}: React.ComponentProps<"div"> & { scrollAreaClassName?: string }) {
  return <div className={cn("min-h-0 overflow-y-auto", scrollAreaClassName, className)} {...props} />;
}

export function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex items-center gap-2 pt-1", className)} {...props} />;
}

export function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return <AlertDialogPrimitive.Title className={cn("text-[13px] font-semibold", className)} {...props} />;
}

export function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      className={cn("text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

type AlertActionProps =
  | (React.ComponentProps<typeof AlertDialogPrimitive.Action> & { asChild: true })
  | (Omit<ButtonProps, "ref"> & { asChild?: false });

export function AlertDialogAction(props: AlertActionProps) {
  if ("asChild" in props && props.asChild) {
    const { asChild: _a, ...rest } = props;
    return <AlertDialogPrimitive.Action asChild {...rest} />;
  }
  const { asChild: _a, className, ...rest } = props as Omit<ButtonProps, "ref"> & { asChild?: false };
  return (
    <AlertDialogPrimitive.Action asChild>
      <Button variant="accent" className={cn("flex-1", className)} {...rest} />
    </AlertDialogPrimitive.Action>
  );
}

type AlertCancelProps =
  | (React.ComponentProps<typeof AlertDialogPrimitive.Cancel> & { asChild: true })
  | (Omit<ButtonProps, "ref"> & { asChild?: false });

export function AlertDialogCancel(props: AlertCancelProps) {
  if ("asChild" in props && props.asChild) {
    const { asChild: _a, ...rest } = props;
    return <AlertDialogPrimitive.Cancel asChild {...rest} />;
  }
  const { asChild: _a, className, ...rest } = props as Omit<ButtonProps, "ref"> & { asChild?: false };
  return (
    <AlertDialogPrimitive.Cancel asChild>
      <Button variant="muted" className={cn("flex-1", className)} {...rest} />
    </AlertDialogPrimitive.Cancel>
  );
}

type AlertDialogOwnProps = {
  trigger?: React.ReactNode;
  title?: React.ReactNode;
  hideTitle?: boolean;
  description?: React.ReactNode;
  hideDescription?: boolean;
  onConfirm?: () => void | Promise<void>;
  confirmLabel?: React.ReactNode;
  confirmVariant?: "accent" | "destructive";
  confirmDisabled?: boolean;
  size?: DialogSize;
};

export function AlertDialog({
  children,
  trigger,
  title,
  hideTitle,
  description,
  hideDescription,
  onConfirm,
  confirmLabel = "Confirm",
  confirmVariant = "accent",
  confirmDisabled,
  size,
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Root> & AlertDialogOwnProps) {
  // Without onConfirm there is no footer to dismiss with, so fall back to
  // composition rather than rendering an alert the user cannot close.
  if (!onConfirm) {
    return (
      <AlertDialogPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange} {...props}>
        {children}
      </AlertDialogPrimitive.Root>
    );
  }
  return (
    <AlertDialogPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange} {...props}>
      {trigger && <AlertDialogPrimitive.Trigger asChild>{trigger}</AlertDialogPrimitive.Trigger>}
      <AlertDialogContent size={size}>
        <AlertDialogHeader>
          <AlertDialogTitle className={hideTitle ? srOnly : undefined}>{title ?? ""}</AlertDialogTitle>
          {description !== undefined && (
            <AlertDialogDescription className={hideDescription ? srOnly : undefined}>
              {description}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {children && <AlertDialogBody>{children}</AlertDialogBody>}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={confirmVariant}
            disabled={confirmDisabled}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialogPrimitive.Root>
  );
}
AlertDialog.displayName = "AlertDialog";

/* ── CustomContextMenu (Radix DOM context menu) ─────────────────────── */

export const CustomContextMenu = ContextMenuPrimitive.Root;
export const CustomContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const CustomContextMenuGroup = ContextMenuPrimitive.Group;
export const CustomContextMenuPortal = ContextMenuPrimitive.Portal;
export const CustomContextMenuSub = ContextMenuPrimitive.Sub;
export const CustomContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup;

const menuContentClass =
  "z-50 min-w-44 overflow-hidden rounded-lg border border-border/60 bg-popover p-1 text-popover-foreground shadow-xl";
const menuItemClass =
  "relative flex cursor-default select-none items-center gap-2 rounded px-2 py-1 text-[13px] outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0";

export const CustomContextMenuContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(function CustomContextMenuContent({ className, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content ref={ref} className={cn(menuContentClass, className)} {...props} />
    </ContextMenuPrimitive.Portal>
  );
});

export const CustomContextMenuItem = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & { inset?: boolean }
>(function CustomContextMenuItem({ className, inset, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Item
      ref={ref}
      className={cn(menuItemClass, inset && "pl-7", className)}
      {...props}
    />
  );
});

export const CustomContextMenuCheckboxItem = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.CheckboxItem>
>(function CustomContextMenuCheckboxItem({ className, children, ...props }, ref) {
  return (
    <ContextMenuPrimitive.CheckboxItem ref={ref} className={cn(menuItemClass, "pl-7", className)} {...props}>
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator>✓</ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  );
});

export const CustomContextMenuRadioItem = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.RadioItem>
>(function CustomContextMenuRadioItem({ className, children, ...props }, ref) {
  return (
    <ContextMenuPrimitive.RadioItem ref={ref} className={cn(menuItemClass, "pl-7", className)} {...props}>
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator>•</ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  );
});

export const CustomContextMenuSubTrigger = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger> & {
    inset?: boolean;
    value?: string;
  }
>(function CustomContextMenuSubTrigger({ className, inset, children, ...props }, ref) {
  return (
    <ContextMenuPrimitive.SubTrigger
      ref={ref}
      className={cn(menuItemClass, "justify-between", inset && "pl-7", className)}
      {...props}
    >
      {children}
      <span aria-hidden className="ml-2 opacity-60">
        ›
      </span>
    </ContextMenuPrimitive.SubTrigger>
  );
});

export const CustomContextMenuSubContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(function CustomContextMenuSubContent({ className, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent ref={ref} className={cn(menuContentClass, className)} {...props} />
    </ContextMenuPrimitive.Portal>
  );
});

export const CustomContextMenuLabel = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label> & { inset?: boolean }
>(function CustomContextMenuLabel({ className, inset, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Label
      ref={ref}
      className={cn("px-2 py-1 text-[11px] font-semibold text-muted-foreground", inset && "pl-7", className)}
      {...props}
    />
  );
});

export const CustomContextMenuSeparator = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(function CustomContextMenuSeparator({ className, ...props }, ref) {
  return <ContextMenuPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
});

export function CustomContextMenuShortcut({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("ml-auto text-[11px] text-muted-foreground", className)} {...props} />;
}
CustomContextMenuShortcut.displayName = "CustomContextMenuShortcut";

/* ── Toaster / toast ────────────────────────────────────────────────── */

export function Toaster(props: React.ComponentProps<typeof SonnerToaster>) {
  return (
    <SonnerToaster
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            "!rounded-lg !border !border-border/60 !bg-popover !text-popover-foreground !shadow-xl !text-[13px]",
          description: "!text-muted-foreground",
        },
      }}
      {...props}
    />
  );
}

export const toast = sonnerToast;

/* ── Date picker (DOM) ──────────────────────────────────────────────── */
//
// The original was native-backed via `dialog.showDatePicker`, an API Electron
// does not have. This is the one component whose mechanism genuinely changed:
// it is now a native HTML date/time input, which is keyboard-accessible and —
// unlike the original — testable in jsdom.

interface DatePickerContextValue {
  value: string | undefined;
  onValueChange?: (value: string) => void;
  type: "date" | "time" | "datetime";
  disabled?: boolean;
}
const DatePickerContext = React.createContext<DatePickerContextValue | null>(null);

export function NativeDatePickerRoot({
  value,
  onValueChange,
  type = "date",
  disabled,
  children,
}: {
  value?: string;
  onValueChange?: (value: string) => void;
  type?: "date" | "time" | "datetime";
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const ctx = React.useMemo(() => ({ value, onValueChange, type, disabled }), [
    value,
    onValueChange,
    type,
    disabled,
  ]);
  return <DatePickerContext.Provider value={ctx}>{children}</DatePickerContext.Provider>;
}

export function NativeDatePickerTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div className={cn("inline-flex items-center gap-1.5", className)} {...props}>
      {children}
    </div>
  );
}

export function NativeDatePickerValue({
  placeholder,
  className,
}: {
  placeholder?: string;
  className?: string;
}) {
  const ctx = React.useContext(DatePickerContext);
  return (
    <input
      type={ctx?.type === "time" ? "time" : ctx?.type === "datetime" ? "datetime-local" : "date"}
      aria-label={placeholder}
      placeholder={placeholder}
      value={ctx?.value ?? ""}
      disabled={ctx?.disabled}
      onChange={(e) => ctx?.onValueChange?.(e.target.value)}
      className={cn(
        "h-7 rounded-md border border-input bg-background px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50",
        className,
      )}
    />
  );
}
