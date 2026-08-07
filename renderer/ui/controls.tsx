// Radix-backed form controls: Checkbox, Switch, RadioGroup, Slider, Tabs,
// SegmentedControl, ScrollArea, Tooltip. DOM-rendered (unlike the original's
// native-backed Select/DropdownMenu — see native-menu.tsx for those).

import * as React from "react";
import {
  Checkbox as CheckboxPrimitive,
  RadioGroup as RadioGroupPrimitive,
  Slider as SliderPrimitive,
  Switch as SwitchPrimitive,
  Tabs as TabsPrimitive,
  ToggleGroup as ToggleGroupPrimitive,
  Tooltip as TooltipPrimitive,
} from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { Check } from "lucide-react";

import { cn } from "./cn";

/* ── Checkbox ───────────────────────────────────────────────────────── */

export function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        "peer size-4 shrink-0 rounded border border-input bg-background shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        <Check className="size-3" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

/* ── Switch ─────────────────────────────────────────────────────────── */

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "peer inline-flex h-5 w-8.5 shrink-0 items-center rounded-full border border-transparent shadow-inner outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-accent data-[state=unchecked]:bg-input",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-4 rounded-full bg-white shadow ring-0 transition-transform data-[state=checked]:translate-x-[15px] data-[state=unchecked]:translate-x-[2px]" />
    </SwitchPrimitive.Root>
  );
}

/* ── RadioGroup ─────────────────────────────────────────────────────── */

export function RadioGroup({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root className={cn("flex items-center gap-3", className)} {...props} />;
}

export function RadioGroupItem({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        "aspect-square size-4 rounded-full border border-input bg-background shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-accent",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="relative flex size-full items-center justify-center">
        <span className="size-2 rounded-full bg-accent" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

/* ── Slider ─────────────────────────────────────────────────────────── */

type SliderSize = "small" | "medium" | "large";
type SliderContent = React.ReactNode | ((value: number) => React.ReactNode);
type BaseSliderProps = Omit<React.ComponentProps<typeof SliderPrimitive.Root>, "size">;

interface DefaultSliderProps extends BaseSliderProps {
  variant?: "default";
}
interface FilledSliderProps extends BaseSliderProps {
  variant: "filled";
  size?: SliderSize;
  startContent?: SliderContent;
  endContent?: SliderContent;
  origin?: number;
  ticks?: boolean | number;
}
export type SliderProps = DefaultSliderProps | FilledSliderProps;

export function Slider(props: SliderProps) {
  const { className, variant: _variant, ...rest } = props as FilledSliderProps;
  // The filled variant's decorations aren't used by this app; both variants
  // render the standard slim slider.
  const { size: _s, startContent: _sc, endContent: _ec, origin: _o, ticks: _t, ...rootProps } =
    rest as FilledSliderProps;
  return (
    <SliderPrimitive.Root
      className={cn("relative flex w-full touch-none items-center select-none", className)}
      {...rootProps}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted">
        <SliderPrimitive.Range className="absolute h-full bg-accent" />
      </SliderPrimitive.Track>
      {(rootProps.value ?? rootProps.defaultValue ?? [0]).map((_, i) => (
        <SliderPrimitive.Thumb
          key={i}
          className="block size-4 rounded-full border border-border/60 bg-white shadow outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none"
        />
      ))}
    </SliderPrimitive.Root>
  );
}

/* ── Tabs ───────────────────────────────────────────────────────────── */

export function TabsRoot({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root className={cn("flex flex-col", className)} {...props} />;
}

const tabsVariants = cva("inline-flex items-center justify-center rounded-lg p-0.5", {
  variants: {
    variant: {
      transparent: "bg-transparent",
      filled: "bg-muted",
      glass: "bg-background/60 border border-border/50 backdrop-blur",
    },
    size: {
      small: "h-6",
      medium: "h-7",
      large: "h-9",
    },
  },
  defaultVariants: { variant: "filled", size: "medium" },
});

export interface TabsProps
  extends React.ComponentProps<typeof TabsPrimitive.List>,
    VariantProps<typeof tabsVariants> {}

export function Tabs({ className, variant, size, ...props }: TabsProps) {
  return <TabsPrimitive.List className={cn(tabsVariants({ variant, size }), className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "inline-flex h-full items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("outline-none", className)} {...props} />;
}

export function TabsSeparator() {
  return <div className="mx-0.5 h-3.5 w-px bg-border" />;
}

/* ── SegmentedControl ───────────────────────────────────────────────── */

const segmentedControlVariants = cva("inline-flex items-center rounded-lg p-0.5 gap-0.5", {
  variants: {
    variant: {
      transparent: "bg-transparent",
      filled: "bg-muted",
      glass: "bg-background/60 border border-border/50 backdrop-blur",
    },
    size: {
      small: "h-6",
      medium: "h-7",
      large: "h-9",
    },
  },
  defaultVariants: { variant: "filled", size: "medium" },
});

type SegBaseProps = Omit<
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>,
  "type" | "value" | "defaultValue" | "onValueChange"
>;
type SegSingleProps = SegBaseProps &
  VariantProps<typeof segmentedControlVariants> & {
    type?: "single";
    allowEmpty?: boolean;
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
  };
type SegMultipleProps = SegBaseProps &
  VariantProps<typeof segmentedControlVariants> & {
    type: "multiple";
    allowEmpty?: never;
    value?: string[];
    defaultValue?: string[];
    onValueChange?: (value: string[]) => void;
  };
export type SegmentedControlProps = SegSingleProps | SegMultipleProps;

export function SegmentedControl(props: SegmentedControlProps) {
  const { className, variant, size } = props;
  if (props.type === "multiple") {
    const { className: _c, variant: _v, size: _s, type: _t, ...rest } = props;
    return (
      <ToggleGroupPrimitive.Root
        type="multiple"
        className={cn(segmentedControlVariants({ variant, size }), className)}
        {...rest}
      />
    );
  }
  const { className: _c, variant: _v, size: _s, type: _t, allowEmpty, value, onValueChange, ...rest } =
    props;
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      className={cn(segmentedControlVariants({ variant, size }), className)}
      value={value}
      onValueChange={(v: string) => {
        // Radix reports deselection as "": suppress it unless allowEmpty.
        if (v === "" && !allowEmpty && value !== undefined) return;
        onValueChange?.(v);
      }}
      {...rest}
    />
  );
}

export function SegmentedControlItem({
  className,
  iconOnly,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> & { iconOnly?: boolean }) {
  return (
    <ToggleGroupPrimitive.Item
      className={cn(
        "inline-flex h-full items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm",
        iconOnly && "aspect-square px-0",
        className,
      )}
      {...props}
    />
  );
}

export function SegmentedControlSeparator() {
  return <div data-separator className="h-3.5 w-px bg-border" />;
}

/* ── Tooltip ────────────────────────────────────────────────────────── */

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={450}>{children}</TooltipPrimitive.Provider>;
}

export function Tooltip({ children, open }: { children: React.ReactNode; open?: boolean }) {
  return <TooltipPrimitive.Root open={open}>{children}</TooltipPrimitive.Root>;
}

export function TooltipTrigger({
  children,
  asChild,
  ...props
}: { children: React.ReactNode; asChild?: boolean } & React.HTMLAttributes<HTMLElement>) {
  return (
    <TooltipPrimitive.Trigger asChild={asChild} {...props}>
      {children}
    </TooltipPrimitive.Trigger>
  );
}

export type TooltipSide = "top" | "bottom" | "left" | "right";

export function TooltipContent({
  children,
  className,
  shortcut,
  side,
}: {
  children?: React.ReactNode;
  className?: string;
  shortcut?: string[];
  side?: TooltipSide;
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        side={side}
        sideOffset={6}
        className={cn(
          "z-50 flex items-center gap-1.5 rounded-md border border-border/60 bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md",
          className,
        )}
      >
        {children}
        {shortcut && shortcut.length > 0 && (
          <span className="flex items-center gap-0.5 text-muted-foreground">
            {shortcut.map((key, i) => (
              <kbd key={i} className="font-sans">
                {key}
              </kbd>
            ))}
          </span>
        )}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}
