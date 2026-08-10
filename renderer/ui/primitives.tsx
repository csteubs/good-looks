// Basic single-element components: Button, Badge, Input, Textarea, Label,
// Status, Text, Table family. Prop contracts mirror the original design
// system's declaration files so the 36 consuming views compile unchanged.

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Label as LabelPrimitive, Slot } from "radix-ui";

import { cn } from "./cn";

/* ── Button ─────────────────────────────────────────────────────────── */

export const buttonVariants = cva(
  // `cursor-pointer` is explicit because nothing supplies it: `body` sets
  // `cursor: default` app-wide, and Tailwind v4's preflight sets it on
  // `button` as well, so a Button drawn without it gives the user no hover
  // feedback at all — the control reads as decoration. The app's own theme
  // layer already makes this the house rule (`.gl-btn`, `.gl-menu-item`,
  // `button.gl-tag-stack` in renderer/theme/primitives.css); this brings the
  // ported component library in line with it. Disabled buttons keep the arrow
  // via `disabled:pointer-events-none`, which suppresses the cursor too.
  "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-fill-secondary text-secondary-foreground hover:bg-fill-secondary/80 active:bg-fill-secondary/70 border border-border/60 shadow-sm",
        secondary: "bg-fill-secondary text-secondary-foreground hover:bg-fill-secondary/80 active:bg-fill-secondary/70 shadow-sm",
        accent: "bg-accent text-accent-foreground hover:bg-accent/90 active:bg-accent/80 shadow-sm",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-sm",
        muted: "bg-muted text-foreground hover:bg-muted/70",
        transparent: "bg-transparent text-foreground hover:bg-muted/70 active:bg-muted",
        ghost: "bg-transparent text-foreground hover:bg-muted/70 active:bg-muted",
        glass: "bg-background/60 text-foreground border border-border/50 backdrop-blur hover:bg-background/80",
      },
      size: {
        small: "h-6 px-2 text-xs",
        medium: "h-7 px-3 text-[13px]",
        large: "h-9 px-4 text-sm",
      },
      iconOnly: {
        true: "px-0 aspect-square",
      },
      radius: {
        default: "",
        full: "rounded-full",
        none: "rounded-none",
      },
    },
    defaultVariants: { variant: "primary", size: "medium" },
  },
);

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "size">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, iconOnly, radius, asChild, type, ...props },
  ref,
) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      ref={ref}
      // A bare <button> submits forms; default to "button" like the original.
      type={asChild ? undefined : (type ?? "button")}
      className={cn(buttonVariants({ variant, size, iconOnly, radius }), className)}
      {...props}
    />
  );
});

/* ── Badge ──────────────────────────────────────────────────────────── */

export type BadgeColor =
  | "primary"
  | "secondary"
  | "blue"
  | "green"
  | "yellow"
  | "orange"
  | "red"
  | "purple"
  | "magenta";

const badgeColorClass: Record<BadgeColor, string> = {
  primary: "bg-accent/15 text-accent",
  secondary: "bg-fill-secondary text-secondary-foreground",
  blue: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  green: "bg-green-500/15 text-green-700 dark:text-green-400",
  yellow: "bg-yellow-500/20 text-yellow-700 dark:text-yellow-400",
  orange: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  red: "bg-red-500/15 text-red-600 dark:text-red-400",
  purple: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  magenta: "bg-pink-500/15 text-pink-600 dark:text-pink-400",
};

export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full font-medium whitespace-nowrap [&_svg]:size-3",
  {
    variants: {
      size: {
        small: "h-4.5 px-1.5 text-[10px]",
        medium: "h-5 px-2 text-[11px]",
        large: "h-6 px-2.5 text-xs",
      },
    },
    defaultVariants: { size: "medium" },
  },
);

export interface BadgeProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof badgeVariants> {
  color?: BadgeColor;
  /** Compatibility alias for `color` — several views spell the colour as
   *  `variant`. `color` wins when both are given. */
  variant?: BadgeColor;
  asChild?: boolean;
}

export function Badge({ className, color, variant, size, asChild, ...props }: BadgeProps) {
  const Comp = asChild ? Slot.Root : "span";
  const resolved = color ?? variant ?? "secondary";
  return (
    <Comp
      className={cn(badgeVariants({ size }), badgeColorClass[resolved] ?? badgeColorClass.secondary, className)}
      {...props}
    />
  );
}

/* ── Input / Textarea ───────────────────────────────────────────────── */

const inputVariants = cva(
  "w-full min-w-0 rounded-md border border-input bg-background text-foreground placeholder:text-muted-foreground outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "",
        filled: "border-transparent bg-muted focus-visible:bg-background",
      },
      size: {
        small: "h-6 px-2 text-xs",
        medium: "h-7 px-2.5 text-[13px]",
        large: "h-9 px-3 text-sm",
      },
    },
    defaultVariants: { variant: "default", size: "medium" },
  },
);

export function Input({
  className,
  type,
  size,
  variant,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & VariantProps<typeof inputVariants>) {
  return <input type={type} className={cn(inputVariants({ variant, size }), className)} {...props} />;
}

/* ── NumberInput ────────────────────────────────────────────────────── */

/**
 * Compact numeric input with an optional unit suffix.
 *
 * Added when `main` grew it and this library had not reproduced it — the merge
 * surfaced it as the one symbol the port was actually missing, rather than as a
 * conflict about an import specifier.
 *
 * Two details are load-bearing and are asserted by the app's own tests, so they
 * are contract rather than styling:
 *
 *   • It is a real `<input type="number">`, so it has role `spinbutton`,
 *     keyboard arrows, and min/max clamping for free. `auto-heal-pane.test.tsx`
 *     queries it by that role.
 *   • `unit` is decoration and is `aria-hidden`. A screen reader gets the unit
 *     from the control's own `aria-label` instead — which is why the panes pass
 *     "…timeout in milliseconds" explicitly. Exposing the suffix here would
 *     double it.
 *
 * `onValueChange` reports `null` for an empty field rather than `NaN` or 0, so
 * clearing the box is distinguishable from typing a zero. Callers coalesce it.
 */
export interface NumberInputProps
  extends Omit<React.ComponentProps<"input">, "size" | "value" | "onChange" | "type">,
    VariantProps<typeof inputVariants> {
  value?: number | null;
  onValueChange?: (value: number | null) => void;
  unit?: React.ReactNode;
  steppers?: boolean;
}

export function NumberInput({
  className,
  size,
  variant,
  value,
  onValueChange,
  unit,
  // Accepted and ignored: the browser's own spinner is what this port uses, so
  // there is nothing to hide. Kept in the signature so a caller passing it
  // still type-checks against the original contract.
  steppers: _steppers,
  ...props
}: NumberInputProps) {
  return (
    <div data-slot="number-input" className={cn("relative inline-flex items-center", className)}>
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value;
          onValueChange?.(raw === "" ? null : Number(raw));
        }}
        className={cn(inputVariants({ variant, size }), unit ? "pr-8" : undefined)}
        {...props}
      />
      {unit ? (
        <span
          data-slot="number-input-unit"
          aria-hidden="true"
          className="pointer-events-none absolute right-2 text-xs text-muted-foreground"
        >
          {unit}
        </span>
      ) : null}
    </div>
  );
}

const textareaVariants = cva(
  "w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-1.5 text-foreground placeholder:text-muted-foreground outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      size: {
        small: "text-xs",
        medium: "text-[13px]",
        large: "text-sm",
      },
    },
    defaultVariants: { size: "medium" },
  },
);

export function Textarea({
  className,
  size,
  ...props
}: Omit<React.ComponentProps<"textarea">, "size"> & VariantProps<typeof textareaVariants>) {
  return <textarea className={cn(textareaVariants({ size }), className)} {...props} />;
}

/* ── Label ──────────────────────────────────────────────────────────── */

export function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn("text-[13px] font-medium text-foreground select-none", className)}
      {...props}
    />
  );
}

/* ── Status ─────────────────────────────────────────────────────────── */

const statusVariants = cva("inline-flex items-center gap-1.5 text-xs font-medium", {
  variants: {
    variant: {
      error: "text-destructive",
      warning: "text-warning",
      loading: "text-muted-foreground",
      success: "text-success",
      neutral: "text-muted-foreground",
    },
  },
  defaultVariants: { variant: "neutral" },
});

const statusDotClass: Record<string, string> = {
  error: "bg-destructive",
  warning: "bg-warning",
  loading: "bg-muted-foreground animate-pulse",
  success: "bg-success",
  neutral: "bg-muted-foreground",
};

export function Status({
  className,
  variant,
  asChild,
  children,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof statusVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";
  return (
    <Comp className={cn(statusVariants({ variant }), className)} {...props}>
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full", statusDotClass[variant ?? "neutral"])}
      />
      {children}
    </Comp>
  );
}

/* ── Text ───────────────────────────────────────────────────────────── */

export const textVariants = cva("", {
  variants: {
    // Names mirror the original design system's text-variants contract.
    variant: {
      small: "text-xs",
      regular: "text-[13px]",
      large: "text-sm",
      heading1: "text-lg font-semibold",
      heading2: "text-base font-semibold",
      "extra-large": "text-xl",
      "extra-large-strong": "text-xl font-semibold",
      "large-strong": "text-sm font-semibold",
      strong: "text-[13px] font-semibold",
      "small-strong": "text-xs font-semibold",
      mini: "text-[11px]",
      "mini-strong": "text-[11px] font-semibold",
      mono: "font-mono text-[13px]",
      "mono-strong": "font-mono text-[13px] font-semibold",
      "small-mono": "font-mono text-xs",
    },
    color: {
      primary: "text-foreground",
      secondary: "text-muted-foreground",
      tertiary: "text-muted-foreground/75",
      quaternary: "text-muted-foreground/50",
      disabled: "text-muted-foreground/50",
      accent: "text-accent",
      link: "text-accent underline underline-offset-2",
      inherit: "text-inherit",
      blue: "text-blue-600 dark:text-blue-400",
      green: "text-green-700 dark:text-green-400",
      magenta: "text-pink-600 dark:text-pink-400",
      orange: "text-orange-600 dark:text-orange-400",
      purple: "text-purple-600 dark:text-purple-400",
      red: "text-red-600 dark:text-red-400",
      yellow: "text-yellow-700 dark:text-yellow-400",
    },
    align: {
      left: "text-left",
      center: "text-center",
      right: "text-right",
    },
    truncate: {
      true: "truncate",
    },
    weight: {
      regular: "font-normal",
      medium: "font-medium",
      semibold: "font-semibold",
      bold: "font-bold",
    },
  },
  defaultVariants: { variant: "regular" },
});

export interface TextProps
  extends Omit<React.ComponentProps<"span">, "color">,
    VariantProps<typeof textVariants> {
  as?: keyof React.JSX.IntrinsicElements;
  asChild?: boolean;
  /** Compatibility alias for `variant` — several views spell the scale as
   *  `size` (e.g. `size="small"`). `variant` wins when both are given. */
  size?: VariantProps<typeof textVariants>["variant"];
}

export function Text({
  className,
  variant,
  size,
  color,
  align,
  truncate,
  weight,
  as,
  asChild,
  ...props
}: TextProps) {
  const Comp: React.ElementType = asChild ? Slot.Root : (as ?? "span");
  return (
    <Comp
      className={cn(
        textVariants({ variant: variant ?? size, color, align, truncate, weight }),
        className,
      )}
      {...props}
    />
  );
}

/* ── Table ──────────────────────────────────────────────────────────── */

export function Table({
  className,
  children,
  stickyHeader: _stickyHeader,
  ...props
}: React.ComponentProps<"table"> & { stickyHeader?: boolean }) {
  return (
    <table className={cn("w-full caption-bottom border-collapse text-[13px]", className)} {...props}>
      {children}
    </table>
  );
}

export function TableHeader({
  className,
  sticky,
  ...props
}: React.ComponentProps<"thead"> & { sticky?: boolean }) {
  return (
    <thead
      className={cn(
        "[&_tr]:border-b",
        sticky && "sticky top-0 z-10 bg-background",
        className,
      )}
      {...props}
    />
  );
}

export function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

export function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return <tfoot className={cn("border-t bg-muted/40 font-medium", className)} {...props} />;
}

export function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      className={cn("border-b border-border/60 transition-colors hover:bg-muted/40", className)}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "h-8 px-2 text-left align-middle text-xs font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return <td className={cn("px-2 py-1.5 align-middle", className)} {...props} />;
}

export function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return <caption className={cn("mt-2 text-xs text-muted-foreground", className)} {...props} />;
}
