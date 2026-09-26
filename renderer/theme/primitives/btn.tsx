// Btn — 30px, uppercase, `.16em`, four tones.
//
//   go     phosphor    run it, accept it, the affirmative action
//   stop   red         stop it, delete it, the destructive one
//   ghost  neutral     everything else
//   ai     holo        hands the job to a model
//
// THE TONES ARE NOT DECORATION AND `ghost` IS THE DEFAULT ON PURPOSE. Colour in
// this design means outcome, and a screen where every button is lit spends the
// whole palette on chrome — so a button only takes a hue when pressing it
// causes the thing that hue means. Two `go` buttons on one screen is a design
// smell, not a style choice.
//
// `ai` is the exception that proves the rule: AI is not an outcome, so it gets
// the holo TREATMENT rather than a colour, and only on the border. Never a text
// fill — `background-clip: text` costs enough contrast to stop a 10px
// letterspaced label being readable, and 10px is the size of this label.

import * as React from "react";

import { TONE, toneSurface } from "../tokens";

export type BtnTone = "go" | "stop" | "ghost" | "ai";

export interface BtnProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Passed through to the <button> (React 19 hands `ref` over as a prop). A
   *  trigger that takes focus back after its popover closes needs it. */
  ref?: React.Ref<HTMLButtonElement>;
  tone?: BtnTone;
}

/** The tinted tones, derived in exactly one place (tokens.ts). `ghost` and `ai`
 *  are absent because neither is a tint: `ghost` is the bare box, and `ai` is
 *  the holo border, which is a stylesheet rule rather than a colour. */
const TINTED: Partial<Record<BtnTone, string>> = {
  go: TONE.phos,
  stop: TONE.red,
};

export function Btn({
  tone = "ghost",
  className,
  style,
  type,
  ...rest
}: BtnProps): React.ReactElement {
  const tint = TINTED[tone];
  return (
    <button
      // Explicitly `button`. The HTML default is `submit`, and one of these
      // inside any form would navigate rather than do its job — a bug that only
      // appears once the primitive is used somewhere with a form around it.
      type={type ?? "button"}
      className={["gl-btn", `gl-btn-${tone}`, className].filter(Boolean).join(" ")}
      style={{ ...(tint ? toneSurface(tint) : null), ...style }}
      data-gl="btn"
      data-tone={tone}
      {...rest}
    />
  );
}
