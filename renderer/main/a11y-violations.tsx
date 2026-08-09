// Shared presentation for accessibility violations.
//
// Two views render these now — the Visual view's step detail and the test's own
// Accessibility tab — and they must not drift. The impact colours ARE the triage
// (a "minor" and a "critical" that look alike defeat the point of ranking them),
// and the new-vs-accepted split is the whole verdict, so a second hand-written
// copy would eventually disagree with the first about which issues matter.
//
// The pure half — ranking, keying, counting — lives in renderer/lib/a11y-format.
// This file is only the pixels.

import { Badge, Text } from "@ui";
import { Accessibility } from "lucide-react";

import { worstNewImpact } from "../lib/a11y-format";
import type { A11yResult, A11yViolation } from "../lib/recorder-types";

/** Colour for an impact level, ranked the way axe ranks it. A "minor" and a
 *  "critical" violation must not look the same — the whole point of triage is
 *  knowing which to read first. */
export const IMPACT_COLOR: Record<A11yViolation["impact"], "red" | "orange" | "yellow" | "secondary"> =
  {
    critical: "red",
    serious: "orange",
    moderate: "yellow",
    minor: "secondary",
  };

/** Compact "N accessibility issues" badge for a step row. */
export function A11yBadge({ result }: { result: A11yResult }) {
  const isNew = result.newKeys.length;
  if (isNew === 0) {
    // Checked and found nothing unaccepted. Worth saying explicitly — silence
    // reads as "the check didn't run", which is a different thing entirely.
    return (
      <Badge color="secondary" className="shrink-0">
        <Accessibility className="size-3.5" />
        {result.acceptedCount > 0 ? `${result.acceptedCount} accepted` : "No a11y issues"}
      </Badge>
    );
  }
  const worst = worstNewImpact(result);
  return (
    <Badge color={worst ? IMPACT_COLOR[worst] : "orange"} className="shrink-0">
      <Accessibility className="size-3.5" />
      {isNew} new a11y issue{isNew === 1 ? "" : "s"}
    </Badge>
  );
}

/**
 * The violations themselves, newest-first is not a thing here — axe's order is
 * kept, but already-accepted ones are dimmed and labelled.
 *
 * Accepted violations are SHOWN rather than hidden: "6 issues, 6 accepted" is
 * useful and honest, while a step that looks empty claims the page is clean.
 */
export function A11yViolationList({ result }: { result: A11yResult }) {
  const newSet = new Set(result.newKeys);
  return (
    <div className="flex flex-col gap-2">
      {result.violations.map((v, i) => {
        const isNew = v.nodes.length
          ? v.nodes.some((t) => newSet.has(`${v.id}|${t}`))
          : newSet.has(`${v.id}|`);
        return (
          <div
            key={i}
            className={`rounded-md border p-2 ${
              isNew ? "border-separator" : "border-separator opacity-60"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge color={IMPACT_COLOR[v.impact]}>{v.impact}</Badge>
              <code className="font-mono text-xs text-secondary">{v.id}</code>
              {!isNew ? <Badge color="secondary">accepted</Badge> : null}
            </div>
            <Text variant="small" className="pt-1">
              {v.help}
            </Text>
            {v.nodes.length > 0 ? (
              <div className="flex flex-col gap-0.5 pt-1">
                {v.nodes.map((t, j) => (
                  <code key={j} className="truncate font-mono text-[11px] text-tertiary">
                    {t}
                  </code>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
