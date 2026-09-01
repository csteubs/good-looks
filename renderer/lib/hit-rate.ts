// The consoles' pass-rate readout: what percentage of executed steps passed,
// and the tone it reads in. One module because the trainer's console and the
// test detail's console answer the same question with the same pill, and two
// copies of the thresholds would eventually disagree about what counts as
// worrying — the drift this repo keeps paying for.

/** Percent hit-rate pill color by score. */
export function hitRateTone(rate: number): string {
  if (rate >= 100) return "text-support-green";
  if (rate >= 50) return "text-support-yellow";
  return "text-support-red";
}
