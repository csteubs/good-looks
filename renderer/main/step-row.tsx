// A single recorded step row. Shared by the read-only test detail view (just
// index + description) and the live trainer (drag-to-reorder, inline edit,
// per-step replay). All editing affordances are gated behind optional props, so
// the detail view stays a plain presentational list.

import * as React from "react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ui";
import { Check, ChevronDown, ChevronRight, GripVertical, Loader2, MoreHorizontal, Pencil, Play, TriangleAlert, Variable, X } from "lucide-react";
import type { RunStepStatus } from "./recorder-store";

import { SEL_BG, SEL_RING, TONE, Temp, TypeChip, formatDuration, insetRail } from "../theme";
import { describeStep } from "../lib/describe-step";
import { gradeLocator } from "../lib/locator-grade";
import { DEFAULT_WAIT_TIMEOUT_MS } from "../lib/recorder-types";
import { clampViewportAxis } from "../lib/viewport-presets";
import type { Step, TestVariable } from "../lib/recorder-types";
import { insertAtCaret, varRef } from "../components/variable-picker";
import { FlowArgsDialog } from "./flow-args-fields";

/* `badgeColor` and `badgeLabel` were here, and `TypeChip` replaces both.
 *
 * They mapped a step type onto one of the SDK's five badge colours and
 * shortened two names. The theme's chip owns the same two jobs from one map, and
 * its palette is DELIBERATELY NOT the status palette: a step's type is not an
 * outcome — an `assert` step is not "failing" because assertions are what fail —
 * so the type colours are desaturated categories while the four status hues stay
 * reserved for results. The old mapping used `green` for `assert`, which is the
 * pass colour, on every assertion in every list. */

/**
 * Parse a hand-typed `WIDTHxHEIGHT` into a viewport patch, or null.
 *
 * Accepts `x`, `×` and `,` as the separator because all three are what people
 * actually type for a size, and rejects anything that doesn't yield two usable
 * numbers — an unparseable draft leaves the step alone rather than resizing to
 * something nobody asked for. The backend clamps the result again on write.
 */
export function parseSizeDraft(draft: string): { width: number; height: number } | null {
  const m = draft.trim().match(/^(\d+)\s*[x×,]\s*(\d+)$/i);
  if (!m) return null;
  const width = clampViewportAxis(m[1], 0);
  const height = clampViewportAxis(m[2], 0);
  if (!width || !height) return null;
  return { width, height };
}

/** Same idea for a position scroll's `x, y`. Unlike a viewport axis, 0 is a
 *  legitimate value on both axes (scrolling back to the top IS a position), so
 *  this parses digits directly rather than through clampViewportAxis, whose
 *  falsy-rejection would refuse it. */
export function parseScrollDraft(draft: string): { scrollX: number; scrollY: number } | null {
  const m = draft.trim().match(/^(\d+)\s*[,x×]\s*(\d+)$/i);
  if (!m) return null;
  const scrollX = parseInt(m[1], 10);
  const scrollY = parseInt(m[2], 10);
  if (!Number.isFinite(scrollX) || !Number.isFinite(scrollY)) return null;
  return { scrollX, scrollY };
}

/** The single field a step exposes for quick inline editing, if any. */
function editableField(
  step: Step,
): { key: "value" | "text" | "url" | "label" | "waitMs" | "timeoutMs" | "loopCount" | "size" | "scrollPos"; label: string; value: string } | null {
  switch (step.type) {
    case "goto":
      return { key: "url", label: "URL", value: step.url ?? "" };
    case "viewport":
      // One field for both axes: a resize is a single decision ("make it
      // mobile"), and two inputs in a row this narrow would each be about
      // four characters wide.
      return {
        key: "size",
        label: "Size (width×height)",
        value: `${step.width ?? 1280}x${step.height ?? 800}`,
      };
    case "scroll":
      // Only the position form is inline-editable; an element scroll's target
      // is edited via Refine, same as every other locator-bearing step.
      if (!step.locator)
        return {
          key: "scrollPos",
          label: "Scroll to (x, y)",
          value: `${step.scrollX ?? 0}, ${step.scrollY ?? 0}`,
        };
      return null;
    case "fill":
    case "select":
    case "press":
      return { key: "value", label: "Value", value: step.value ?? "" };
    case "wait":
      // A conditional wait's editable number is its TIMEOUT, not a duration —
      // it has no waitMs at all. Without this the one number the user can see
      // on the row would be the only one they couldn't change inline.
      if (step.waitUntil)
        return {
          key: "timeoutMs",
          label: "Timeout (ms)",
          value: String(step.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
        };
      return typeof step.waitMs === "number"
        ? { key: "waitMs", label: "Wait (ms)", value: String(step.waitMs) }
        : null;
    case "assert":
      if (step.assert === "text" || step.assert === "exactText")
        return { key: "text", label: "Text", value: step.text ?? "" };
      if (step.assert === "value" || step.assert === "url" || step.assert === "urlEndsWith" || step.assert === "urlIs" || step.assert === "urlPathIs" || step.assert === "title" || step.assert === "titleContains")
        return { key: "value", label: "Expected", value: step.value ?? "" };
      if (step.assert === "attribute")
        return { key: "value", label: "Expected", value: step.value ?? "" };
      // The expected value is the half of a CSS assert most likely to need a
      // tweak (a brand colour changes; the property doesn't), so it gets the
      // same inline edit `attribute` has. The property name and match mode are
      // not inline-editable — one is validated, the other is an enum, and
      // neither fits a bare text field on a row this narrow.
      if (step.assert === "css")
        return { key: "value", label: "Expected", value: step.value ?? "" };
      return null;
    case "if":
      // Page-condition substring is inline-editable; element conditions edit via Refine.
      if (step.cond === "urlContains" || step.cond === "titleContains")
        return { key: "value", label: "Contains", value: step.value ?? "" };
      return null;
    case "loop":
      // The count is the loop step's whole content — same rule as waitMs.
      return { key: "loopCount", label: "Times", value: String(step.loopCount ?? 1) };
    case "group":
      // The name is the group's whole content, same rule again.
      return { key: "label", label: "Group name", value: step.label ?? "" };
    case "download":
      return { key: "value", label: "Filename", value: step.value ?? "" };
    default:
      return null;
  }
}

/** Inline fields a `${var}` reference belongs in.
 *
 *  Only the ones the generator interpolates. The numeric fields are emitted as
 *  bare numerals — `waitMs`, `timeoutMs`, a viewport axis — so a reference in
 *  one would not be a variable, it would be a spec that doesn't parse. */
const VAR_FIELD_KEYS = ["value", "text", "url"] as const;

interface NativeMenu {
  popup: (options: {
    items: { label?: string; type?: "normal" | "separator"; commandId?: number }[];
    x?: number;
    y?: number;
    coordinateSpace?: "screen" | "view";
  }) => Promise<{ commandId?: number }>;
}
function nativeMenu(): NativeMenu {
  return (window as unknown as { glazeAPI: { Menu: NativeMenu } }).glazeAPI.Menu;
}

/**
 * What the active insert cursor says when it is not at the end of the list.
 *
 * Exported so both trainers use one string, and so a test can assert the copy
 * without re-typing it — the same reason `DOCK_TOOLTIP` is exported.
 */
export const INSERT_HERE = "New steps go here";

/**
 * Thin clickable strip between rows that moves the insert cursor.
 *
 * Lives beside StepRow rather than in either view because BOTH step lists —
 * the main window's trainer and the docked panel's — need it, and an insert
 * cursor that behaves differently in the two would be a confusing bug: the
 * cursor decides where the next captured step lands.
 */
export function CursorGap({
  active,
  onClick,
  disabled,
  label,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  /** Words for the active cursor when it is NOT at the end of the list.
   *
   *  At the end it needs none — steps appearing under the last row is what
   *  everybody already expects. Anywhere else it is the answer to "where did my
   *  step go", and a 1px cyan rule is not an answer. Continuing an existing
   *  test opens the cursor just past the navigation, so this is the common
   *  case there rather than an exotic one. */
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="gl-cursor-gap"
      data-active={active ? "" : undefined}
      data-labelled={active && label ? "" : undefined}
      aria-label="Move insert point here"
    >
      {/* Label first: it sits in the left gutter, in line with the step-index
          column the eye already scans, rather than at the far end of a rule
          that is a full window wide in the main trainer. */}
      {active && label ? <span className="gl-cursor-gap-label">{label}</span> : null}
      <span className="gl-cursor-gap-rule" aria-hidden="true" />
    </button>
  );
}

export interface StepDragProps {
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
  isDragging: boolean;
  isOver: boolean;
}

export function StepRow({
  index,
  step,
  selected,
  onSelect,
  onDelete,
  onReplay,
  onRefine,
  onEdit,
  onOpenFlow,
  onUnwrapFlow,
  expanded,
  onToggleExpand,
  drag,
  runStatus,
  isNew,
  justAdded,
  replayFlash,
  indent = 0,
  trend,
  variables = [],
}: {
  index: number;
  step: Step;
  selected?: boolean;
  /** Row click. Receives the event so hosts with multi-selection can read the
   *  shift/⌘ modifiers; single-selection hosts just ignore the argument. */
  onSelect?: (e: React.MouseEvent) => void;
  onDelete?: () => void;
  onReplay?: () => Promise<{ ok: boolean; error?: string }>;
  onRefine?: () => void;
  onEdit?: (patch: Partial<Step>) => void;
  /** Navigate to the flow a `runFlow` step calls. Only meaningful on hosts
   *  that can navigate (the detail view); ignored for other step types. */
  onOpenFlow?: (flowId: string) => void;
  /** Replace this `runFlow` step with the flow's steps, bound as a run would
   *  bind them. The host owns the confirm and the actual write. */
  onUnwrapFlow?: () => void;
  /** Whether the host is showing this flow call's steps inline beneath the
   *  row. Only meaningful with `onToggleExpand`, and only on `runFlow` rows. */
  expanded?: boolean;
  /** Toggle the inline preview of the flow's steps. The host owns what is
   *  rendered — this row only draws the chevron. */
  onToggleExpand?: () => void;
  drag?: StepDragProps;
  /** Live run status of this step during a test run, for highlight. */
  runStatus?: RunStepStatus;
  /**
   * This step's own duration trend, from `metrics-store` (C §6.3).
   *
   * BOTH NUMBERS ARE MEDIANS, and neither is "this run". That is the design
   * rather than a limitation: a single run's duration for a single step is
   * noise — a garbage collection, a slow DNS answer — and colouring it would
   * light half the list on every run for reasons that are not about the test.
   * `Temp` reads recent-median against earlier-median, so what it colours is
   * the step having CHANGED, which is the one thing worth a colour here.
   *
   * Absent when metrics are unavailable, when this step has no timed history,
   * or when it has recent runs and nothing to compare them against. `Temp`
   * falls to `off` on a missing median by itself, so there is nothing to guard
   * at the call site.
   */
  trend?: { recentP50Ms: number | null; previousP50Ms: number | null };
  /** This step was just added to the list by something other than the user
   *  typing it — an applied AI-debug fix, an inserted AI-generated flow — and
   *  gets a pulsing green border until the list changes again. Only ADDED
   *  steps are marked; removals are deliberately unstyled. */
  isNew?: boolean;
  /**
   * This is the step that most recently ARRIVED in the list — captured in the
   * training browser, added from a dialog, generated.
   *
   * It scrolls itself into view, and that is the point of it rather than a side
   * effect. The insert cursor sits where the browser is, so continuing an
   * existing test writes new steps into the middle of the list while the view
   * follows the bottom: the row that changed was off-screen, which reads as the
   * trainer not having recorded anything. `isNew` cannot do this job — it says
   * an AI put the step here, and stays true for a whole batch until the list
   * changes again, so scrolling on it would fight the user's own scrolling.
   */
  justAdded?: boolean;
  /** This step just finished replaying, and whether it passed. Ephemeral — the
   *  store clears it after REPLAY_FLASH_MS. Drawn as an outline, which is why
   *  it and `isNew` are mutually exclusive below rather than additive. */
  replayFlash?: "pass" | "fail";
  /** Nesting depth inside conditional blocks, for left indentation. */
  indent?: number;
  /** Variables the owning test declares. Non-empty puts an insert button beside
   *  the inline editor, which is the only way to write a `${name}` reference
   *  without already knowing the syntax exists. Empty (the default) leaves the
   *  read-only detail list exactly as it was. */
  variables?: TestVariable[];
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  // "Edit Flow Arguments…" dialog for runFlow steps. Local to the row: unlike
  // Refine (which needs the training browser's pick mode), the args editor is
  // self-contained, so parents get it for free wherever onEdit is wired.
  const [flowArgsOpen, setFlowArgsOpen] = React.useState(false);
  const rowRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  // Where the caret was when the variable menu was opened, and a latch that
  // stops the input's blur from committing while it is open.
  //
  // The latch is load-bearing: `Menu.popup` is a real macOS menu, so opening it
  // takes focus off the page and fires `blur` on the input — which would commit
  // and unmount the editor before the user had picked anything, leaving the
  // pick with nothing to insert into.
  const menuOpen = React.useRef(false);
  const caret = React.useRef(0);
  // `block: "nearest"` so a row already on screen is left exactly where it is —
  // a step captured at the bottom of a short list must not make the list jump
  // to prove it arrived.
  React.useEffect(() => {
    if (!justAdded) return;
    rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [justAdded]);
  const [replay, setReplay] = React.useState<{
    status: "idle" | "running" | "ok" | "fail";
    error?: string;
  }>({ status: "idle" });

  const field = onEdit ? editableField(step) : null;

  function beginEdit() {
    if (!field) return;
    setDraft(field.value);
    setEditing(true);
  }

  function commitEdit() {
    if (!field || !onEdit) return setEditing(false);
    if (field.key === "size") {
      // An unparseable size commits NOTHING rather than a partial patch: a
      // resize with only a width is not a smaller edit, it's a broken step.
      const size = parseSizeDraft(draft);
      if (size) onEdit(size);
      return setEditing(false);
    }
    if (field.key === "scrollPos") {
      // Same rule as size: both axes or nothing.
      const pos = parseScrollDraft(draft);
      if (pos) onEdit(pos);
      return setEditing(false);
    }
    // The remaining numeric fields are parsed here rather than stored as the
    // typed string: they are emitted into the spec as bare numerals, and a
    // string reaching the generator is the shape of the original injection bug.
    const patch: Partial<Step> =
      field.key === "waitMs"
        ? { waitMs: Number(draft) || 0 }
        : field.key === "timeoutMs"
          ? { timeoutMs: Number(draft) || DEFAULT_WAIT_TIMEOUT_MS }
          : field.key === "loopCount"
            ? { loopCount: Math.min(500, Math.max(1, Math.trunc(Number(draft) || 1))) }
            : { [field.key]: draft };
    onEdit(patch);
    setEditing(false);
  }

  // Variables are offered only for the fields that are interpolated, and only
  // when the host supplied any — see VAR_FIELD_KEYS.
  const canInsertVar =
    !!field && variables.length > 0 && (VAR_FIELD_KEYS as readonly string[]).includes(field.key);

  async function openVariableMenu(anchor: HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    let picked: number | undefined;
    try {
      const res = await nativeMenu().popup({
        x: Math.round(rect.left),
        y: Math.round(rect.bottom),
        coordinateSpace: "view",
        items: variables.map((v, i) => ({ label: varRef(v.name), commandId: i })),
      });
      picked = res.commandId;
    } finally {
      menuOpen.current = false;
    }
    const chosen = typeof picked === "number" ? variables[picked] : undefined;
    if (!chosen) {
      // Dismissed without choosing: put the caret back rather than leaving the
      // editor open but unfocused, which reads as a frozen field.
      inputRef.current?.focus();
      return;
    }
    const ref = varRef(chosen.name);
    const next = insertAtCaret(draft, caret.current, ref);
    setDraft(next);
    const at = Math.min(caret.current, draft.length) + ref.length;
    // After the state has landed, so the input holds `next` when the caret is
    // placed — setting it against the old value puts it in the wrong place.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(at, at);
    });
  }

  async function doReplay() {
    if (!onReplay) return;
    setReplay({ status: "running" });
    try {
      const res = await onReplay();
      setReplay({ status: res.ok ? "ok" : "fail", error: res.error });
    } catch (err) {
      setReplay({ status: "fail", error: String(err) });
    }
    setTimeout(() => setReplay({ status: "idle" }), 2500);
  }

  // STATUS IS A RAIL, NOT A BACKGROUND (B5a). It used to be a tinted fill plus a
  // ring — `bg-support-red/15 ring-1 ring-inset ring-support-red/40` and
  // friends — which is three problems at once in this palette. A filled row is
  // the largest coloured surface on the screen, so a list with four failures
  // reads as mostly-red before a word of it is scanned; a ring draws on all four
  // sides, so a column of rows becomes a stack of boxes rather than a list; and
  // the fill sat under the description, which is the text the colour is
  // actually about. The rail is 2px on the leading edge, same motif as every
  // other status in this design, and it leaves the row's own surface alone.
  //
  // An inset SHADOW rather than a border, for the reason stated everywhere else
  // this appears: a border participates in layout, so a list where some rows
  // have one and some do not jumps by 2px per run status — which happens live,
  // step by step, while a run is in flight.
  const runRail =
    runStatus === "running"
      ? TONE.cyan
      : runStatus === "passed"
        ? TONE.phos
        : runStatus === "failed"
          ? TONE.red
          : null;

  // The replay flash keeps a fill, and that is deliberate rather than an
  // oversight: it is a 2.5s ANSWER to something the user just clicked, not a
  // persistent property of the row, and it has to be visible without them
  // hunting for a 2px edge. Run status is the opposite — it lands on every row
  // at once and stays.
  const flash = runRail
    ? ""
    : replay.status === "ok"
      ? "bg-support-green-10"
      : replay.status === "fail"
        ? "bg-support-red-10"
        : "hover:bg-control-subtle";

  // Additive rather than another arm of the `flash` chain above: run status and
  // selection are transient states of a row, this is a claim about where the
  // row came from, and a step can be new AND failing — which is the single most
  // interesting row on the screen, so neither highlight may hide the other.
  // `.step-new` animates only `outline-color`, which nothing else here touches
  // (see renderer/styles.css), so the two compose instead of fighting.
  //
  // The replay flash and `.step-new` both draw an OUTLINE, so unlike the pair
  // above these cannot compose — two outline rules on one element resolve by
  // stylesheet order, which is not a decision either component made. The flash
  // wins while it lasts: it is the newer fact and the one the user is waiting
  // on, and it expires on its own, so `.step-new` comes back underneath rather
  // than being lost.
  //
  // `justAdded` is last of the three for the same reason: it is the weakest
  // claim (a step arrived) and the other two are about what happened to it. An
  // AI-inserted step is both, and keeping its green pulse is right — the flash
  // would expire and leave the provenance highlight looking like it had failed
  // to appear.
  const outlineClass = replayFlash
    ? replayFlash === "pass"
      ? "step-replay-pass"
      : "step-replay-fail"
    : isNew
      ? "step-new"
      : justAdded
        ? "step-just-added"
        : "";

  return (
    <div
      ref={rowRef}
      data-new-step={isNew ? "true" : undefined}
      data-just-added={justAdded ? "true" : undefined}
      data-replay-flash={replayFlash}
      // `gl-step-list-row` is what makes the row — and only the row — size to
      // its own step: it extends past the viewport when the step is long, and
      // fills the column when it is short. It sits on the row rather than on
      // the list because a `max-content` COLUMN stretches everything else in
      // the list with it (see `.gl-step-list` in theme/shared.css).
      className={`gl-step-list-row group flex items-center gap-2 rounded-md px-2 py-1 ${flash} ${outlineClass} ${
        drag?.isOver ? "border-t-2 border-accent" : ""
      } ${drag?.isDragging ? "opacity-50" : ""} ${onSelect ? "cursor-pointer" : ""}`}
      // SELECTION IS NEUTRAL, and that is the palette's load-bearing rule rather
      // than a preference: colour means outcome here, so a selected row drawn in
      // the accent would be competing with what the status rail beside it is
      // reporting — and on a row that is both selected and failing the two would
      // be arguing. White at low alpha, no hue. `check:selection-neutral` pins
      // it, because the next person to touch this will reasonably reach for the
      // accent colour.
      //
      // Both the rail and the selection lift are box-shadows, so they compose in
      // one declaration instead of one replacing the other. Order matters: the
      // rail is listed first so it paints over the selection fill's edge.
      style={{
        ...(indent ? { marginLeft: indent * 20 } : null),
        boxShadow:
          [
            runRail ? insetRail(runRail) : null,
            selected ? `inset 0 0 0 1px ${SEL_RING}` : null,
          ]
            .filter(Boolean)
            .join(", ") || undefined,
        background: selected ? SEL_BG : undefined,
      }}
      onDragEnter={drag ? () => drag.onDragEnter() : undefined}
      onDragOver={drag ? (e) => e.preventDefault() : undefined}
      onDrop={drag ? (e) => e.preventDefault() : undefined}
      onClick={onSelect ? (e) => {
        // Don't select when clicking an interactive control inside the row.
        const target = e.target as HTMLElement;
        if (target.closest("button, input, [contenteditable]")) return;
        onSelect(e);
      } : undefined}
      aria-selected={selected ? true : undefined}
      role={onSelect ? "option" : undefined}
    >
      {drag ? (
        <span
          draggable
          onDragStart={drag.onDragStart}
          onDragEnd={drag.onDragEnd}
          className="shrink-0 cursor-grab text-tertiary opacity-0 group-hover:opacity-100 active:cursor-grabbing"
          aria-label="Drag to reorder"
        >
          <GripVertical className="size-4" />
        </span>
      ) : null}

      {/* 1-based, and tabular so a column of them does not shimmy as it
          scrolls. A reader counts from one, and a failure report that says
          "step 0" costs someone a minute. */}
      <span className="gl-row-index shrink-0">{index + 1}</span>
      {onToggleExpand && step.type === "runFlow" && step.flowId ? (
        <button
          type="button"
          className="gl-icon-btn shrink-0"
          aria-label={expanded ? "Collapse flow steps" : "Show the flow's steps"}
          aria-expanded={expanded ? true : false}
          title={expanded ? "Collapse flow steps" : "Show the flow's steps"}
          onClick={onToggleExpand}
        >
          {expanded ? (
            <ChevronDown className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden="true" />
          )}
        </button>
      ) : null}
      <TypeChip type={step.type} />
      {/* Neutral chips, all three: soft / continue-on-fail / disabled are facts
          about how the step is CONFIGURED, not results, and giving any of them
          a status hue would make every configured step look like a verdict. */}
      {step.soft ? <span className="gl-chip">soft</span> : null}
      {step.continueOnFailure ? (
        <span className="gl-chip" title="Continue on Failure — swallow this step's error and keep running">
          continue on fail
        </span>
      ) : null}
      {step.disabled ? (
        <span className="gl-chip" title="Disabled — skipped during runs and commented out in the spec">
          disabled
        </span>
      ) : null}

      {editing && field ? (
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <input
            ref={inputRef}
            type="text"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              // Not a commit: the variable menu has focus, and this editor has
              // to still be here when it closes. See `menuOpen`.
              if (menuOpen.current) return;
              commitEdit();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              if (e.key === "Escape") setEditing(false);
            }}
            className="gl-input min-w-0 flex-1"
            aria-label={`Edit ${field.label}`}
          />
          {canInsertVar ? (
            <button
              type="button"
              className="gl-icon-btn shrink-0"
              aria-label="Insert a variable"
              title="Insert a variable"
              // Both halves matter. `preventDefault` on mousedown keeps the
              // browser from moving focus off the input at all, which is what
              // lets the caret position below still be the user's; the latch
              // covers the blur the native menu causes anyway when it opens.
              onMouseDown={(e) => {
                e.preventDefault();
                menuOpen.current = true;
                caret.current = inputRef.current?.selectionStart ?? draft.length;
              }}
              onClick={(e) => void openVariableMenu(e.currentTarget)}
            >
              <Variable className="size-3.5" />
            </button>
          ) : null}
        </span>
      ) : (
        <span
          className="gl-mono-value flex-1"
          // The failing row's description is the one place a status hue belongs
          // on this text: it IS the outcome, on the row that has it.
          style={runStatus === "failed" ? { color: TONE.red } : undefined}
          title={replay.error || describeStep(step)}
        >
          {describeStep(step)}
        </span>
      )}

      {/* Locator fragility, the quiet way: only the two risky tiers render
          anything, and the full sentence rides the accessible name (the
          Radix-tooltip trap — hover-only copy is copy jsdom and keyboards
          never reach). With Refine wired it is a button straight into the
          fix; read-only lists get the same glyph as information. */}
      {(() => {
        const grade = gradeLocator(step.locator);
        if (!grade || editing) return null;
        const cls =
          grade.tier === "positional"
            ? "gl-icon-btn shrink-0 text-support-yellow-orange"
            : "gl-icon-btn shrink-0 text-tertiary";
        return onRefine ? (
          <button
            type="button"
            className={cls}
            onClick={onRefine}
            aria-label={`${grade.detail} Opens Refine Selection.`}
            title={grade.detail}
          >
            <TriangleAlert aria-hidden="true" />
          </button>
        ) : (
          <span role="img" className={cls} aria-label={grade.detail} title={grade.detail}>
            <TriangleAlert aria-hidden="true" />
          </span>
        );
      })()}

      {!editing ? (
        // `gl-step-row-actions` is what keeps this cluster reachable once a
        // long step widens the column past the viewport (`.gl-step-list`): the
        // rows all stretch to the widest one, so without it every row's delete
        // and edit buttons would sit off the right edge and cost a horizontal
        // scroll to reach — on rows whose own text fits perfectly.
        <div className="gl-step-row-actions ml-auto flex shrink-0 items-center gap-0.5">
          {/* Before the run glyph, because the glyph is about THIS run and the
              temp is about the step's history — and the row reads outward from
              what is happening now. `rule` rather than `tint`: the numbers sit
              in a row of controls, and a coloured numeral among icons reads as
              a status badge. */}
          {trend && trend.recentP50Ms !== null ? (
            <Temp
              ms={trend.recentP50Ms}
              median={trend.previousP50Ms}
              mode="rule"
              title={
                trend.previousP50Ms
                  ? undefined
                  : `${formatDuration(trend.recentP50Ms)} median — no earlier runs to compare against`
              }
            />
          ) : null}
          {runStatus ? (
            <span
              className="flex shrink-0 items-center [&_svg]:size-3.5"
              aria-label={`Step ${runStatus}`}
              // COLOUR MEANS OUTCOME, and this is the one place on the row that
              // is reporting one. `running` is cyan rather than the SDK accent,
              // which is the token the palette declares for "running / live".
              style={{
                color:
                  runStatus === "running"
                    ? TONE.cyan
                    : runStatus === "passed"
                      ? TONE.phos
                      : TONE.red,
              }}
            >
              {runStatus === "running" ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : runStatus === "passed" ? (
                <Check aria-hidden="true" />
              ) : (
                <X aria-hidden="true" />
              )}
            </span>
          ) : null}
          {/* `viewport` IS replayable on its own — it resizes the training
              window, which is exactly the thing worth previewing before
              trusting the step. `goto`/`endif` still aren't: one restarts the
              session's navigation, the other is a block delimiter.

              A lone `press` isn't either: replaying it holds the left mouse
              button down in the live training window with no `release` coming,
              so the user's next click there would be a drag. It only means
              anything as part of the run that also releases it. */}
          {onReplay &&
          step.type !== "goto" &&
          step.type !== "else" &&
          step.type !== "endif" &&
          step.type !== "loop" &&
          step.type !== "endLoop" &&
          step.type !== "group" &&
          step.type !== "endGroup" &&
          step.type !== "teardown" &&
          !(step.type === "state" && step.elementState === "press") ? (
            <button
              type="button"
              className="gl-icon-btn opacity-0 group-hover:opacity-100"
              onClick={doReplay}
              disabled={replay.status === "running"}
              aria-label="Replay step"
              style={
                replay.status === "ok"
                  ? { color: TONE.phos }
                  : replay.status === "fail"
                    ? { color: TONE.red }
                    : undefined
              }
            >
              {replay.status === "running" ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : replay.status === "ok" ? (
                <Check aria-hidden="true" />
              ) : replay.status === "fail" ? (
                <X aria-hidden="true" />
              ) : (
                <Play aria-hidden="true" />
              )}
            </button>
          ) : null}
          {field ? (
            <button
              type="button"
              className="gl-icon-btn opacity-0 group-hover:opacity-100"
              onClick={beginEdit}
              aria-label="Edit step"
            >
              <Pencil aria-hidden="true" />
            </button>
          ) : null}
          {(() => {
            // "Test step utilities" submenu: groups per-step tools beneath the
            // row. Currently "Refine Selection" (needs a locator) and "Continue
            // on Failure" (a toggle for action/assert steps). The kebab trigger
            // only renders when at least one utility applies to this step.
            const canRefine = onRefine && step.locator;
            const canContinue =
              onEdit &&
              step.type !== "if" &&
              step.type !== "else" &&
              step.type !== "endif" &&
              step.type !== "loop" &&
              step.type !== "endLoop" &&
              // An AI check never fails the run, so continue-on-failure would
              // be a wrapper around nothing — and the generator emits the
              // plain line regardless, which would silently drop the flag on
              // the next round-trip.
              step.type !== "aiCheck" &&
              step.type !== "group" &&
              step.type !== "endGroup" &&
              step.type !== "teardown";
            const isFlowCall = step.type === "runFlow" && !!step.flowId;
            const canFlowArgs = onEdit && isFlowCall;
            const canOpenFlow = onOpenFlow && isFlowCall;
            const canUnwrap = onUnwrapFlow && isFlowCall;
            if (!canRefine && !canContinue && !canFlowArgs && !canOpenFlow && !canUnwrap)
              return null;
            return (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="gl-icon-btn opacity-0 group-hover:opacity-100"
                    aria-label="Step utilities"
                    title="Step utilities"
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="end">
                  {canOpenFlow ? (
                    <DropdownMenuItem onSelect={() => onOpenFlow?.(step.flowId!)}>
                      Go to Flow
                    </DropdownMenuItem>
                  ) : null}
                  {canUnwrap ? (
                    <DropdownMenuItem onSelect={onUnwrapFlow}>
                      Unwrap Flow…
                    </DropdownMenuItem>
                  ) : null}
                  {(canOpenFlow || canUnwrap) && (canRefine || canContinue || canFlowArgs) ? (
                    <DropdownMenuSeparator />
                  ) : null}
                  {canRefine ? (
                    <DropdownMenuItem onSelect={onRefine} icon="crosshair">
                      Refine Selection
                    </DropdownMenuItem>
                  ) : null}
                  {canFlowArgs ? (
                    <DropdownMenuItem onSelect={() => setFlowArgsOpen(true)}>
                      Edit Flow Arguments…
                    </DropdownMenuItem>
                  ) : null}
                  {(canRefine || canFlowArgs) && canContinue ? <DropdownMenuSeparator /> : null}
                  {canContinue ? (
                    <DropdownMenuCheckboxItem
                      checked={!!step.continueOnFailure}
                      onCheckedChange={(checked) => onEdit?.({ continueOnFailure: checked })}
                    >
                      Continue on Failure
                    </DropdownMenuCheckboxItem>
                  ) : null}
                  {canContinue ? (
                    <DropdownMenuCheckboxItem
                      checked={!!step.disabled}
                      onCheckedChange={(checked) => onEdit?.({ disabled: checked })}
                    >
                      Disable Step
                    </DropdownMenuCheckboxItem>
                  ) : null}
                  {/* Click steps only, and off by default on purpose: the
                      strict check catches real bugs (a button no user could
                      press), and this is the escape for targets covered or
                      animating BY DESIGN. */}
                  {onEdit && step.type === "click" ? (
                    <DropdownMenuCheckboxItem
                      checked={!!step.force}
                      onCheckedChange={(checked) => onEdit?.({ force: checked })}
                    >
                      Ignore Actionability (force)
                    </DropdownMenuCheckboxItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            );
          })()}
          {onDelete ? (
            <button
              type="button"
              className="gl-icon-btn opacity-0 group-hover:opacity-100"
              onClick={onDelete}
              aria-label="Delete step"
            >
              <X aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
      {flowArgsOpen ? (
        <FlowArgsDialog
          step={step}
          open={flowArgsOpen}
          onOpenChange={setFlowArgsOpen}
          onSave={(patch) => onEdit?.(patch)}
        />
      ) : null}
    </div>
  );
}
