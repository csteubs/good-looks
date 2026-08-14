// "Which one did you mean?" — the element-context picker.
//
// ── The problem ────────────────────────────────────────────────────────────
// The element a user picks is often one of many similar ones: the Edit button
// in the Billing card, one row of nine identical rows. The recorder resolves
// that alone — `pickLocator` asks the page how many elements each candidate
// matches and, when none is unique, silently settles for a generated CSS path
// like `body > section:nth-of-type(1) > button`. That runs today and breaks on
// the first layout change, and the user watching it happen has nowhere to put
// the one thing they know and the recorder cannot infer.
//
// This is that place. Ticking a row pins a property of the element — most
// usefully the container it lives in — onto the step's locator, where it scopes
// the emitted Playwright locator AND hard-filters Auto-Heal's candidates.
//
// ── Two rules the UI enforces, both from the data model ────────────────────
// A container is a CHOICE (one `within` per locator), so those rows behave like
// radios. Attributes and classes ACCUMULATE (`and` is a list), so those behave
// like checkboxes. Rendering both as checkboxes would let the user tick two
// containers and silently drop one.
//
// ── Why the numbers are not decoration ─────────────────────────────────────
// Every row is priced: how many elements still match once that signal is
// applied. Without them the user is guessing whether "inside .card" narrows
// nine matches to one or to four — and guessing is what this exists to replace.
// Because context is a real constraint at run time, a signal that narrows
// NOTHING is a pure loss: it cannot help and it can break. The counts are what
// make that visible.
//
// The per-row counts are a snapshot from the moment of the pick, which is what
// orders them. The COMBINED count cannot be derived from them — two signals
// that each leave three matches might leave three between them or none — so the
// selection's own count is asked of the live page (`api.recorder.countMatches`).

import * as React from "react";
import { Badge, Text } from "@ui";

import { api } from "../lib/api";
import type {
  ContextSignal,
  ContextSignalKind,
  Locator,
  LocatorContext,
  PickedElement,
} from "../lib/recorder-types";

/** Copy the picker shows, exported because Radix-backed tooltips cannot be
 *  opened in jsdom and a string only reachable by hover is a string no test can
 *  assert on. */
export const CONTEXT_HEADING = "Which one did you mean?";
export const CONTEXT_AMBIGUOUS_HINT =
  "No locator identifies this element on its own — without more context the test will use a generated path that breaks when the page changes.";
export const CONTEXT_UNIQUE_HINT =
  "This element already has a locator of its own. Extra context is rarely needed, and every pinned property is one more thing that can change.";
export const CONTEXT_BRITTLE_NOTE = "changes often";
export const CONTEXT_NO_SIGNALS = "Nothing on this element distinguishes it from the others.";

/** Durability ranking, most durable first — the order rows are offered in.
 *
 *  A ranking rather than a filter, because durability is a property of the SITE
 *  and not of the property kind: a class name is brittle in a utility-class
 *  codebase and perfectly stable in a hand-written one, and the user knows
 *  which they have. So the brittle kinds are ranked last and LABELLED, never
 *  hidden — hiding them would mean the picker silently withholds the only
 *  signal some pages offer. */
const KIND_RANK: Record<ContextSignalKind, number> = {
  within: 0,
  withinHasText: 1,
  attr: 2,
  class: 3,
};

const KIND_LABEL: Record<ContextSignalKind, string> = {
  within: "Inside",
  withinHasText: "Inside, containing",
  attr: "Attribute",
  class: "Class",
};

/** Kinds that pick a CONTAINER, and are therefore mutually exclusive. */
function isContainerKind(k: ContextSignalKind): boolean {
  return k === "within" || k === "withinHasText";
}

/** Attribute names that identify rather than describe. Ranked above the rest so
 *  a `data-qa` sits above a `type="button"` that is true of half the page. */
function isIdentifyingAttr(name: string): boolean {
  return name.startsWith("data-") || name === "id" || name === "aria-label";
}

export function signalRank(s: ContextSignal): number {
  return (
    KIND_RANK[s.kind] * 1000 +
    (s.resolves ? 0 : 500) +
    (s.kind === "attr" && !isIdentifyingAttr(s.name) ? 100 : 0) +
    // Within a tier, the signal that narrows most comes first.
    Math.min(s.count, 99)
  );
}

/** A row's stable identity. Kind + name + value, because the same value can
 *  legitimately appear under two kinds (a container's text and an attribute). */
function signalId(s: ContextSignal): string {
  return `${s.kind}|${s.name}|${s.value}`;
}

/** Merge the ticked rows into one context.
 *
 *  Order matters for `and`: the emitted chain and the heal key are both built
 *  in list order, so this walks the SORTED rows rather than a Set's iteration
 *  order, which would make the same selection produce different source
 *  depending on the order the boxes happened to be clicked. */
export function buildContext(signals: ContextSignal[], picked: Set<string>): LocatorContext | null {
  const out: LocatorContext = {};
  const and: Locator[] = [];
  for (const s of signals) {
    if (!picked.has(signalId(s))) continue;
    if (isContainerKind(s.kind)) {
      if (s.ctx.within) out.within = s.ctx.within;
      if (s.ctx.withinHasText !== undefined) out.withinHasText = s.ctx.withinHasText;
    } else if (s.ctx.and) {
      and.push(...s.ctx.and);
    }
  }
  if (and.length > 0) out.and = and;
  // Absent and empty are the same value — see `normalizeLocatorContext`.
  return out.within || out.and ? out : null;
}

/** Uncontrolled by design: the ticked set lives here and is reported upward via
 *  `onChange`. A `value` prop would imply the caller could drive the selection,
 *  which nothing needs and which would make the container/predicate merge rules
 *  a shared responsibility rather than this component's own. */
export function ElementContextPicker({
  picked,
  onChange,
}: {
  picked: PickedElement;
  onChange: (ctx: LocatorContext | null) => void;
}) {
  const signals = React.useMemo(
    () => [...(picked.contextSignals ?? [])].sort((a, b) => signalRank(a) - signalRank(b)),
    [picked],
  );

  // Expanded when the recorder could not identify the element on its own — the
  // "one of many similar selectors" case, and the app's own admission that what
  // it would otherwise record is a generated path rather than a description.
  // Collapsed otherwise: because a pinned property is load-bearing at run time,
  // prompting where the locator is already unique invites pinning that costs
  // stability and buys nothing.
  const [open, setOpen] = React.useState(picked.ambiguous);
  const [ticked, setTicked] = React.useState<Set<string>>(new Set());

  // A fresh pick is a fresh question. Keyed on `picked` rather than reset by a
  // caller, so every re-target starts from nothing ticked.
  React.useEffect(() => {
    setTicked(new Set());
    setOpen(picked.ambiguous);
  }, [picked]);

  const ctx = React.useMemo(() => buildContext(signals, ticked), [signals, ticked]);

  // Report upward whenever the selection changes — and ONLY then.
  //
  // Through a ref rather than by listing `onChange` as a dependency: both call
  // sites pass an inline closure, which is a new function identity on every
  // parent render, so depending on it would re-run this effect constantly and
  // push an identical context back up each time. The parent stores that on the
  // locator, re-renders, and the cycle continues. The ref keeps the effect
  // keyed on the thing that actually changed while still calling the latest
  // callback.
  const onChangeRef = React.useRef(onChange);
  React.useEffect(() => {
    onChangeRef.current = onChange;
  });
  React.useEffect(() => {
    onChangeRef.current(ctx);
  }, [ctx]);

  // The live count for the CURRENT selection. Asked of the page, because it
  // cannot be derived from the per-row counts.
  const [liveCount, setLiveCount] = React.useState<number | null>(null);
  React.useEffect(() => {
    const base = picked.contextBase;
    if (!base) return;
    if (!ctx) {
      setLiveCount(picked.contextBaseCount);
      return;
    }
    let cancelled = false;
    setLiveCount(null);
    void api.recorder
      .countMatches({ ...base, ctx })
      .then((n) => {
        if (!cancelled) setLiveCount(n);
      })
      .catch(() => {
        if (!cancelled) setLiveCount(-1);
      });
    return () => {
      cancelled = true;
    };
  }, [ctx, picked]);

  if (signals.length === 0 && !picked.ambiguous) return null;

  function toggle(s: ContextSignal): void {
    const id = signalId(s);
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      // A container is a choice, not an accumulation: picking one replaces any
      // other. The data model holds ONE `within`, so allowing two ticked would
      // silently drop whichever lost.
      if (isContainerKind(s.kind)) {
        for (const other of signals) {
          if (isContainerKind(other.kind)) next.delete(signalId(other));
        }
      }
      next.add(id);
      return next;
    });
  }

  const total = picked.contextBaseCount;

  return (
    <div className="flex flex-col gap-2" data-gl="element-context">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 text-left"
        aria-expanded={open}
      >
        <Text variant="small" color="secondary">
          {open ? "▾" : "▸"} {CONTEXT_HEADING}
        </Text>
        {!open && total > 1 ? (
          <Badge color="orange">{total} match{total === 1 ? "" : "es"}</Badge>
        ) : null}
      </button>

      {open ? (
        <div className="flex flex-col gap-2">
          <Text variant="small" color="tertiary">
            {picked.ambiguous ? CONTEXT_AMBIGUOUS_HINT : CONTEXT_UNIQUE_HINT}
          </Text>

          {signals.length === 0 ? (
            <Text variant="small" color="tertiary">
              {CONTEXT_NO_SIGNALS}
            </Text>
          ) : (
            <div className="flex flex-col gap-1">
              {signals.map((s) => {
                const id = signalId(s);
                const on = ticked.has(id);
                const brittle = s.kind === "class";
                return (
                  <button
                    key={id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggle(s)}
                    className={`flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                      on ? "border-accent bg-accent/10" : "border-separator hover:bg-background-secondary"
                    }`}
                  >
                    <span
                      className={`size-3.5 shrink-0 rounded border ${
                        on ? "border-accent bg-accent" : "border-separator"
                      }`}
                    />
                    <Badge color={on ? "blue" : "secondary"} className="shrink-0">
                      {KIND_LABEL[s.kind]}
                    </Badge>
                    <code className="min-w-0 flex-1 truncate font-mono text-xs text-primary">
                      {s.kind === "attr" ? `${s.name}="${s.value}"` : s.value}
                    </code>
                    {brittle ? (
                      <Text variant="small" color="tertiary" className="shrink-0">
                        {CONTEXT_BRITTLE_NOTE}
                      </Text>
                    ) : null}
                    {/* The price. `resolves` gets its own colour because "this
                        one tick ends the ambiguity" is the outcome worth
                        steering to — it is also the shortest emitted locator. */}
                    <Badge color={s.resolves ? "green" : "secondary"} className="shrink-0">
                      {s.count}
                    </Badge>
                  </button>
                );
              })}
            </div>
          )}

          <Text variant="small" color={liveCount === 1 ? "secondary" : "tertiary"}>
            {liveCount === null
              ? "Counting…"
              : liveCount < 0
                ? // Never "0 matches": that is a claim about the page, and this
                  // is a failure to ask it.
                  "Could not count matches on the page."
                : `Matches ${liveCount} of ${total} element${total === 1 ? "" : "s"}.`}
          </Text>
        </div>
      ) : null}
    </div>
  );
}
