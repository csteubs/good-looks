// Apply a list of offset-based text edits to a string. Edits are applied
// from the end so earlier offsets stay valid; overlapping edits are the
// caller's mistake and are applied as given.

export interface OffsetEdit {
  from: number;
  to: number;
  text: string;
}

export function applyTextEdits(text: string, edits: readonly OffsetEdit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.from - a.from || b.to - a.to)) {
    out = out.slice(0, e.from) + e.text + out.slice(e.to);
  }
  return out;
}
