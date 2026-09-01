// The trainer's mechanical next-action rules (PR 2 of the bar plan): given
// what just happened in the session, compute the ONE suggestion worth a chip
// in the context band — or null, which is most of the time.
//
// NO LLM, deliberately. Everything here is a rule a person would state the
// same way twice: "you just filled a field, the commonest next step is to
// assert its value"; "the page just moved, pin where it landed". The AI
// suggestion strip is a later phase with a settings flag and its own egress
// gate, because it SENDS page content somewhere; these rules read only the
// step list and the URL the trainer already displays, so there is nothing to
// gate.
//
// Pure, and in renderer/lib so the node vitest project covers it. The one
// input a pure function cannot compute is `navigatedSinceLastStep` — whether
// the page URL changed AFTER the last step landed needs memory of what the
// URL was when it landed — so the view-side hook (useNextAction in
// trainer-bar-controls.tsx) tracks that and hands the fact in.

import type { AssertKind, PickedElement, Step } from "./recorder-types";
import { urlAssertPrefill } from "../../shared/url-assert.mjs";

export interface NextActionInput {
  /** The live step list, in list order. */
  steps: Step[];
  /** The insert cursor — the gap index the next captured step lands in. The
   *  anchor for every rule is the step BEFORE the cursor, not the array's
   *  last: in a continued session the cursor sits mid-list, and "what just
   *  happened" is what landed there. */
  cursor: number;
  /** Where the page is now ("" when unknown). */
  liveUrl: string;
  /** True when the page URL changed after the anchor step landed — the
   *  view-side signal that the anchor step navigated. */
  navigatedSinceLastStep: boolean;
}

/** One suggestion, carrying everything the chip and its accept path need.
 *  `picked`/`assert`/`prefillValue` are exactly the composer's context-pick
 *  seed, so accepting is the same move on both surfaces whatever the rule.
 *  `id` is the dismissal identity: dismissing hides THIS suggestion, and a
 *  suggestion with a new id is a new offer. */
export interface NextActionSuggestion {
  id: string;
  rule: "fill-assert" | "url-assert";
  label: string;
  title: string;
  assert: AssertKind;
  picked: PickedElement | null;
  prefillValue: string;
}

/** Rebuild a composer-shaped picked element from a recorded step — the
 *  fingerprint when the capture stored one, the bare locator otherwise. The
 *  RECORDED locator goes first in the candidates: the assertion must point at
 *  what the step pointed at, not at whichever alternative the fingerprint
 *  ranked first. Null when the step carries nothing to point with. */
export function pickedFromStep(step: Step): PickedElement | null {
  const fp = step.fingerprint;
  const seen = new Set<string>();
  const candidates = [step.locator, ...(fp?.candidates ?? [])].filter(
    (loc): loc is NonNullable<typeof loc> => {
      if (!loc) return false;
      const key = JSON.stringify(loc);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  );
  if (candidates.length === 0) return null;
  return {
    tag: fp?.tag ?? "",
    description: fp?.description ?? step.label ?? "",
    candidates,
    css: {},
    attributes: fp?.attributes ?? {},
    ambiguous: false,
    contextBaseCount: 0,
    contextSignals: [],
    text: fp?.text,
    neighborText: fp?.neighborText,
  };
}

function urlSuggestion(anchorId: string, url: string): NextActionSuggestion | null {
  // `urlAssertPrefill` already refuses about:blank, data: URLs and anything
  // it cannot stand behind — an empty answer means no suggestion, never a
  // chip that opens an empty form.
  const prefillValue = urlAssertPrefill("urlPathIs", url);
  if (!prefillValue) return null;
  return {
    // The prefill is part of the identity: a dismissed chip stays dismissed
    // through a redirect chain that settles on the same path, and a landing
    // on a genuinely different path is a new offer.
    id: `url:${anchorId}:${prefillValue}`,
    rule: "url-assert",
    label: "Assert the URL path",
    title: `Open the assertion form prefilled with “URL path is ${prefillValue}” — pins the page this recording has arrived at.`,
    assert: "urlPathIs",
    picked: null,
    prefillValue,
  };
}

/** The rules, in the order they win:
 *
 *  1. The anchor step navigated → assert the URL path. This beats the fill
 *     rule ON PURPOSE: a fill whose page then moved is a field that is no
 *     longer there, and an element suggestion for it would arm a form whose
 *     assertion cannot pass.
 *  2. The anchor is a `goto` → assert the path of ITS url, not the live one:
 *     an inserted goto has not been executed, so the live page is wherever it
 *     was, which is exactly the wrong thing to pin. A baseUrl-relative goto
 *     yields no suggestion (`urlAssertPrefill` cannot parse it) — honest
 *     silence over a plausible value from the wrong page.
 *  3. The anchor is a `reload` → assert the live URL's path.
 *  4. The anchor is a `fill` → assert the field's value, unless the field is
 *     a password or the value interpolates a variable (a secret's VALUE must
 *     not be transcribed into an assertion), with the prefill EMPTY for a
 *     `sequential` fill (it appends rather than replaces, so the recorded
 *     value is not what the field holds — an empty field the user fills
 *     beats a plausible value they do not check).
 */
export function suggestNextAction(input: NextActionInput): NextActionSuggestion | null {
  const { steps, cursor, liveUrl, navigatedSinceLastStep } = input;
  const anchorIndex = Math.min(cursor, steps.length) - 1;
  const anchor = anchorIndex >= 0 ? steps[anchorIndex] : undefined;
  if (!anchor) return null;

  if (navigatedSinceLastStep) return urlSuggestion(anchor.id, liveUrl);
  if (anchor.type === "goto") return urlSuggestion(anchor.id, anchor.url ?? "");
  if (anchor.type === "reload") return urlSuggestion(anchor.id, liveUrl);

  if (anchor.type === "fill") {
    if (anchor.fingerprint?.attributes?.type === "password") return null;
    if ((anchor.varRefs?.length ?? 0) > 0 || (anchor.value ?? "").includes("${")) return null;
    const picked = pickedFromStep(anchor);
    if (!picked) return null;
    const prefillValue = anchor.typeMode === "sequential" ? "" : (anchor.value ?? "");
    return {
      id: `fill:${anchor.id}`,
      rule: "fill-assert",
      label: "Assert this field’s value",
      title:
        "Open the assertion form prefilled with the field you just filled and the value it should hold — the commonest check after typing.",
      assert: "value",
      picked,
      prefillValue,
    };
  }

  return null;
}

/** A name for the flow a selection is about to become, prefilled into the
 *  create-flow dialog's field (still the user's to edit). Mechanical: the
 *  LAST named click in the range — the button the steps exist to reach — and
 *  "Sign in" when the range fills a password field but clicks nothing
 *  nameable. "" when there is nothing honest to offer. */
export function suggestFlowName(steps: Step[], selectionIds: string[]): string {
  const chosen = new Set(selectionIds);
  const selected = steps.filter((s) => chosen.has(s.id));
  for (let i = selected.length - 1; i >= 0; i--) {
    const s = selected[i];
    if (s.type !== "click" && s.type !== "dblclick") continue;
    const name = clickName(s);
    if (name) return name;
  }
  if (
    selected.some(
      (s) => s.type === "fill" && s.fingerprint?.attributes?.type === "password",
    )
  ) {
    return "Sign in";
  }
  return "";
}

function clickName(step: Step): string {
  const raw =
    step.locator?.name ??
    (step.locator?.k === "text" || step.locator?.k === "label" ? step.locator.v : undefined) ??
    step.fingerprint?.text;
  const name = (raw ?? "").replace(/\s+/g, " ").trim();
  // A name longer than a button label is prose, not a name.
  return name.length > 0 && name.length <= 40 ? name : "";
}
