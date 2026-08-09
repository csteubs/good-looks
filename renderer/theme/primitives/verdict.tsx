// Verdict — a tone dot and a sentence, for summary panels.
//
// THE ONE PLACE THIS DESIGN USES SANS AND PROSE. Everything else is mono,
// uppercase and letterspaced, which is right for labels and wrong for a
// sentence: `.12em` tracking on a full clause is genuinely slower to read, and
// a verdict is the thing on the screen most likely to be read rather than
// scanned.
//
// THE DOT CARRIES THE COLOUR, NOT THE TEXT. Coloured body text at this size is
// a contrast problem — `--gl-red` on `--gl-panel` is fine for a 9px uppercase
// chip and marginal for a 12px sentence — and it also makes the sentence look
// like a status rather than an explanation. The dot says which; the words say
// why.

import * as React from "react";

import { TONE } from "../tokens";
import type { ToneName } from "../tokens";

export interface VerdictProps {
  tone: ToneName;
  /** The claim, in a sentence. */
  children: React.ReactNode;
  /** Optional second line — the evidence behind the claim. */
  detail?: React.ReactNode;
}

export function Verdict({ tone, children, detail }: VerdictProps): React.ReactElement {
  return (
    <div className="gl-verdict" data-gl="verdict" data-tone={tone}>
      <span className="gl-verdict-dot" style={{ background: TONE[tone] }} aria-hidden />
      <div className="gl-verdict-body">
        <p className="gl-verdict-text">{children}</p>
        {detail !== undefined ? <p className="gl-verdict-detail">{detail}</p> : null}
      </div>
    </div>
  );
}
