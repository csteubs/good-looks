// The triage line in the run Output panel.
//
// The classifier's own rules are pinned by check:triage. What this covers is
// the half that lives in the component, where being wrong is quiet: the panel
// renders, the words are plausible, and the user acts on them.
//
//   • A verdict shown WITHOUT its evidence is an assertion. The strongest piece
//     must be on screen unconditionally, not behind the disclosure.
//   • `unknown` must render. Hiding it hides the one case where the user can
//     actually change something (turn capture on and run it again).
//   • `limits` must be reachable. They are the reason a verdict is soft, and a
//     verdict read without them is read as firmer than it is.
//   • A stale response must not paint the previous run's verdict onto this one.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

import { RunTriage, VERDICT_LABEL, confidenceLabel } from "./run-triage";
import type { TriageResult } from "../../shared/triage.mjs";

const h: { triage: (id: string) => Promise<TriageResult | null> } = {
  triage: async () => null,
};

vi.mock("../lib/api", () => ({
  api: { runs: { triage: (id: string) => h.triage(id) } },
}));

function result(over: Partial<TriageResult> = {}): TriageResult {
  return {
    verdict: "site",
    confidence: 0.68,
    evidence: [
      { signal: "server-error", direction: "site", detail: "The failing step saw a 503 response." },
      { signal: "all-engines", direction: "site", detail: "Fails on every engine tried." },
    ],
    limits: ["900 network entries were discarded by the per-run cap."],
    failingStepId: "step-2",
    suggestedNext: "Open the run's network report for the failing step.",
    ...over,
  };
}

beforeEach(() => {
  h.triage = async () => result();
});

describe("the triage line", () => {
  it("names the verdict and its strongest evidence without being expanded", async () => {
    render(<RunTriage runId="run-1" />);
    // Wait for CONTENT, not a container — the component renders null until the
    // query resolves, so anything that succeeds immediately is a false pass.
    await screen.findByText(VERDICT_LABEL.site);
    expect(screen.getByText(/503 response/)).toBeTruthy();
    expect(screen.getByText(/network report/)).toBeTruthy();
  });

  it("states its confidence rather than presenting the verdict as settled", async () => {
    render(<RunTriage runId="run-1" />);
    expect(await screen.findByText(confidenceLabel(0.68))).toBeTruthy();
  });

  it("keeps the remaining evidence and the limits behind one disclosure", async () => {
    render(<RunTriage runId="run-1" />);
    await screen.findByText(VERDICT_LABEL.site);
    expect(screen.queryByText(/every engine/)).toBeNull();
    expect(screen.queryByText(/discarded by the per-run cap/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /more/ }));

    expect(await screen.findByText(/every engine/)).toBeTruthy();
    // The limits sit WITH the evidence: a verdict read without them reads as
    // firmer than it is.
    expect(screen.getByText(/discarded by the per-run cap/)).toBeTruthy();
  });

  it("renders an unknown verdict rather than hiding it", async () => {
    h.triage = async () =>
      result({
        verdict: "unknown",
        confidence: 0,
        evidence: [],
        limits: ["This run captured no artifacts."],
        suggestedNext: "Re-run this test with capture enabled.",
      });
    render(<RunTriage runId="run-1" />);

    expect(await screen.findByText(VERDICT_LABEL.unknown)).toBeTruthy();
    // The actionable half. Hiding the row would hide this.
    expect(screen.getByText(/capture enabled/)).toBeTruthy();
    // Zero confidence is not rendered as "0% confident", which reads as a bug.
    expect(screen.queryByText(/0% confident/)).toBeNull();
  });

  it("renders nothing when there is no verdict to give", async () => {
    h.triage = async () => null;
    const { container } = render(<RunTriage runId="run-1" />);
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  it("survives the query failing, because a failed run must not also show an error", async () => {
    h.triage = async () => {
      throw new Error("metrics unavailable");
    };
    const { container } = render(<RunTriage runId="run-1" />);
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  it("does not paint a slow verdict for one run onto the next", async () => {
    let release: (r: TriageResult) => void = () => {};
    h.triage = (id) =>
      id === "run-1"
        ? new Promise<TriageResult>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(result({ verdict: "runner", evidence: [], limits: [] }));

    const { rerender } = render(<RunTriage runId="run-1" />);
    rerender(<RunTriage runId="run-2" />);
    await screen.findByText(VERDICT_LABEL.runner);

    // run-1's answer arrives late. It belongs to a run that is no longer shown.
    release(result({ verdict: "site" }));

    await waitFor(() => expect(screen.queryByText(VERDICT_LABEL.site)).toBeNull());
    expect(screen.getByText(VERDICT_LABEL.runner)).toBeTruthy();
  });
});

describe("the verdict dot", () => {
  // COLOUR MEANS OUTCOME, and two of the four verdicts are not one. The whole
  // point of this block is the pair that must stay NEUTRAL: "evidence both
  // ways" and "not enough evidence" are the classifier declining to call it,
  // and a coloured dot would have the component assert what the reasoning
  // behind it refused to.
  const dot = () => document.querySelector('[data-gl="verdict"]') as HTMLElement | null;

  async function renderVerdict(verdict: TriageResult["verdict"]) {
    h.triage = async () => result({ verdict });
    render(<RunTriage runId={`run-${verdict}`} />);
    await screen.findByText(new RegExp(VERDICT_LABEL[verdict], "i"));
    return dot()!;
  }

  it("marks a site verdict amber — caution, go and look there", async () => {
    expect((await renderVerdict("site")).dataset.tone).toBe("amber");
  });

  it("marks a runner verdict red — the failure is in the test you wrote", async () => {
    expect((await renderVerdict("runner")).dataset.tone).toBe("red");
  });

  it("leaves a mixed verdict without a tone", async () => {
    expect((await renderVerdict("mixed")).dataset.tone).toBe("neutral");
  });

  it("leaves an unknown verdict without a tone", async () => {
    expect((await renderVerdict("unknown")).dataset.tone).toBe("neutral");
  });

  it("never marks a triage verdict as a pass", async () => {
    // The run has already failed. A green dot anywhere on this panel reads as
    // a pass no matter what the sentence beside it says.
    for (const verdict of ["site", "runner", "mixed", "unknown"] as const) {
      h.triage = async () => result({ verdict });
      const { unmount } = render(<RunTriage runId={`pass-check-${verdict}`} />);
      await screen.findByText(new RegExp(VERDICT_LABEL[verdict], "i"));
      expect(dot()?.dataset.tone, verdict).not.toBe("phos");
      unmount();
    }
  });
});
