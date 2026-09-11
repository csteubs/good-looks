// Every primitive, in every state, on one page.  `/?view=specimen`
//
// PART OF THE BROWSER PREVIEW, NEVER SHIPPED. It lives in `renderer/dev/`
// alongside the fake backend for the same reason that does: it is a development
// surface, and `preview.html` is the only entry that reaches it.
//
// WHY IT EARNS ITS PLACE. A3 lands fifteen presentational components that no
// screen consumes yet, and the tests can only assert what a component DOES —
// jsdom has no layout engine and the dom suite runs with `css: false`, so
// nothing in the suite has ever seen one of these rendered. Without this page
// the first time anyone looks at a `StatusChip` is inside a Phase B screen,
// where a spacing mistake is indistinguishable from a layout mistake in the
// screen itself.
//
// It is also where the contracts are visible rather than merely asserted: the
// status column has one edge, the selected rows are grey beside coloured ones,
// and the CRT's contents are not tinted by the overlays behind it.

import * as React from "react";

import "../styles.css";
import { Button, Dialog, DialogActions } from "@ui";
import {
  Atmosphere,
  Btn,
  CRT,
  Calendar,
  InsertGap,
  KeyValue,
  MenuItem,
  Panel,
  RailFlyout,
  RailRow,
  Segmented,
  ShotHighlight,
  SiteIcon,
  StatusChip,
  StepRow,
  TagStack,
  Temp,
  ToolTile,
  TypeChip,
  Verdict,
  Hint,
  ChromeButton,
} from "../theme";
import type { TempMode } from "../theme";
import type { StepType } from "../lib/recorder-types";
import { CheckSquare, GitBranch, Plus, RotateCcw, Wand2 } from "lucide-react";
import { buildBranchMenu, type BranchMenuInput } from "../lib/branch-menu";
import { BranchMenu } from "../main/branch-menu";
// Not a primitive, and here anyway. §6.1's five panels are the same problem
// this page was built for: only ONE of them is reachable from the preview's
// fixtures (a test that has run and passed), so `healed`, `retry` and `never`
// would first be seen by a user rather than by us.
import { RunSummaryPanel } from "../main/run-summary-panel";
import type { RunSummary } from "../lib/run-summary";
// The evidence figure's shots. Generated SVG data URIs, same coin as the
// Visual screen's frames and for the same three reasons (diffable, no
// binary, no egress) — and the frame draws a button whose position the
// specimen's rect can point at.
import { visualFrame } from "./preview-fixtures";

/** The six run states, in the order a test tends to meet them. `failed` is
 *  absent because its panel is `RunTriage`, which needs a backend query. */
const RUN_SUMMARIES: RunSummary[] = [
  { state: "never", stepCount: 6 },
  { state: "running", done: 2, total: 6, failedSoFar: 0, elapsedMs: 4_200 },
  {
    state: "passed",
    stepCount: 6,
    durationMs: 12_400,
    medianMs: 11_900,
    deltaPct: 4.2,
    captured: true,
    a11yChecks: 6,
    a11yNewSteps: 2,
    aiChecksPassed: 2,
    aiChecksFailed: 1,
    aiChecksUnevaluated: 0,
  },
  {
    state: "healed",
    healedSteps: 1,
    healFailedSteps: 0,
    pendingReview: 1,
    entries: [
      {
        id: "h-1",
        testId: "t-login",
        stepId: "s4",
        stepIndex: 3,
        stepLabel: 'click "Sign in"',
        source: "run",
        runId: "r-2",
        at: 0,
        originalLocator: { k: "testid", v: "signin" },
        appliedLocator: { k: "role", role: "button", name: "Sign in" },
        candidates: [],
        applied: false,
        status: "pending",
      },
    ],
  },
  {
    state: "retry",
    attempt: 0,
    durationMs: 9_100,
    stepCount: 6,
    differences: [{ label: "Browser", before: "WebKit", after: "Chromium" }],
    previous: {
      id: "r-0",
      testId: "t-login",
      testName: "Login",
      url: "https://app.example.com/login",
      status: "failed",
      exitCode: 1,
      startedAt: 0,
      finishedAt: 8_100,
      durationMs: 8_100,
      logFile: "/preview/runs/r-0.log",
      logBytes: 0,
    },
  },
  // The reading that decides whether somebody goes looking for a fix that does
  // not exist, so it gets its own specimen rather than sharing `retry`'s.
  {
    state: "retry",
    attempt: 0,
    durationMs: 9_100,
    stepCount: 6,
    differences: [],
    previous: {
      id: "r-0",
      testId: "t-login",
      testName: "Login",
      url: "https://app.example.com/login",
      status: "failed",
      exitCode: 1,
      startedAt: 0,
      finishedAt: 8_100,
      durationMs: 8_100,
      logFile: "/preview/runs/r-0.log",
      logBytes: 0,
    },
  },
];

const ALL_TYPES: StepType[] = [
  "goto",
  "click",
  "fill",
  "press",
  "select",
  "check",
  "uncheck",
  "assert",
  "wait",
  "viewport",
  "if",
  "endif",
  "cookie",
  "capture",
  "runFlow",
  "state",
];

/** The evidence figure's three states. The rect is `visualFrame`'s own drawn
 *  button (x 24, y 300, 260×44 on a 960×600 canvas), normalized — so the
 *  measured box demonstrably wraps a real element, and a geometry mistake
 *  reads as a box around nothing. */
const SHOT_BUTTON = { x: 24 / 960, y: 300 / 600, w: 260 / 960, h: 44 / 600 };
const SHOT_HIGHLIGHT_SPECIMENS: { key: string; node: React.ReactNode }[] = [
  {
    key: "measured",
    node: (
      <ShotHighlight
        shot={visualFrame("after-heal.png")}
        rect={SHOT_BUTTON}
        label={'getByTestId("pay-now")'}
        caption="Measured — the run's own bounding box, settling once"
        alt="Screenshot with the healed element boxed"
      />
    ),
  },
  {
    key: "approximate",
    node: (
      <ShotHighlight
        shot={visualFrame("target-step.png")}
        rect={SHOT_BUTTON}
        approximate
        label={'getByRole("button", { name: "Pay now" })'}
        caption="Approximate — where it sat when the step was recorded"
        alt="Screenshot with the recorded position dashed"
      />
    ),
  },
  {
    key: "boxless",
    node: (
      <ShotHighlight
        shot={visualFrame("no-rect-kept.png")}
        caption="No box — this run kept no rectangle, and that is fine"
        alt="Screenshot with no highlight"
      />
    ),
  },
];

/** The branch flyout's states. Built from real `buildBranchMenu` inputs rather
 *  than hand-written rows, so the page shows what the rules produce and not
 *  what someone hoped they produce. */
const BRANCH_MENU_SPECIMENS: { label: string; input: BranchMenuInput }[] = (() => {
  const now = 1_770_000_000_000;
  const day = 86_400_000;
  const branches = [
    { name: "main", updatedAt: now, subject: "⌘K: a command palette that does not guess" },
    { name: "feat/step-reordering", updatedAt: now - day, subject: "drag to reorder trainer steps" },
    { name: "fix/heal-journal-retention", updatedAt: now - 2 * day, subject: "roll up before pruning" },
    { name: "chore/bump-playwright", updatedAt: now - 3 * day, subject: "playwright 1.55" },
    { name: "feat/a11y-panel-filters", updatedAt: now - 4 * day, subject: "filter violations by impact" },
    { name: "docs/decisions-2026-08", updatedAt: now - 5 * day, subject: "" },
    { name: "feat/older-thing", updatedAt: now - 40 * day, subject: "something from a while ago" },
  ];
  const pulls = [
    {
      number: 91,
      title: "Reorder steps by dragging",
      branch: "feat/step-reordering",
      author: "csteubs",
      draft: false,
      updatedAt: "2026-08-11T09:00:00Z",
      url: "https://github.com/csteubs/good-looks/pull/91",
      fork: false,
    },
    {
      number: 89,
      title: "Bump Playwright to 1.55",
      branch: "chore/bump-playwright",
      author: "csteubs",
      draft: true,
      updatedAt: "2026-08-10T09:00:00Z",
      url: "https://github.com/csteubs/good-looks/pull/89",
      fork: false,
    },
  ];
  const status = {
    available: true,
    switched: false,
    hasToken: true,
    current: "main",
    checkoutBranch: "main",
  };
  return [
    { label: "with pull requests", input: { status, branches, pulls } },
    {
      // What everyone without a token, or over the unauthenticated rate limit,
      // or on a non-GitHub remote actually sees. No icons, and the menu still
      // has to be worth opening.
      label: "no pull-request data",
      input: { status, branches, pulls: undefined },
    },
    {
      // The running branch is older than the five most recent, so it displaces
      // the oldest of them — the row that answers "what am I running?".
      label: "running a branch build",
      input: {
        status: { ...status, switched: true, current: "feat/older-thing" },
        branches,
        pulls,
      },
    },
  ];
})();

function Row({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, minHeight: 34 }}>
      <span
        style={{
          flex: "0 0 130px",
          fontFamily: "var(--gl-mono)",
          fontSize: 9,
          letterSpacing: "var(--gl-track-label)",
          textTransform: "uppercase",
          color: "var(--gl-tx-3)",
        }}
      >
        {label}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {children}
      </div>
    </div>
  );
}

/** The trainer panel's dialog box, at its real width, with its content edge
 *  drawn. 296 = `PANEL_WIDTH` 360 - 4rem; the `p-4` inside is the dialog's own.
 *  A button laid out outside the dashed rule is the bug this exists to show. */
function PanelWidthBox({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div
      style={{
        width: 296,
        padding: 16,
        borderRadius: 12,
        background: "var(--gl-panel)",
        outline: "1px dashed var(--gl-tx-3)",
        outlineOffset: -16,
      }}
    >
      {children}
    </div>
  );
}

export function Specimen(): React.ReactElement {
  const [mode, setMode] = React.useState<"tint" | "rule" | "bar" | "delta" | "halo" | "off">("tint");
  const [seg, setSeg] = React.useState<"current" | "baseline" | "diff">("diff");
  const [cursor, setCursor] = React.useState(2);
  // A FIXED clock, not `Date.now()`. The specimen is the only place a
  // primitive can be looked at rendered, and a calendar that shows a different
  // month every day is one nobody can compare against yesterday's screenshot.
  const CAL_TODAY = new Date(2026, 7, 17, 14, 30).getTime();
  const [calDay, setCalDay] = React.useState(new Date(2026, 7, 18).getTime());
  const [crt, setCrt] = React.useState(false);
  const [exitOpen, setExitOpen] = React.useState(false);

  return (
    <>
      {/* The real thing, so the layers are actually over this page — which is
          what makes the CRT's z-610 visible rather than theoretical. */}
      <Atmosphere level="calm" crt={crt} />

      <div
        style={{
          background: "var(--gl-ink)",
          minHeight: "100vh",
          padding: "22px 22px 60px",
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
          alignItems: "start",
        }}
      >
        <Panel title="Btn" id="four tones" pad={12}>
          <div style={{ display: "grid", gap: 10 }}>
            <Row label="tones">
              <Btn tone="go">Run test</Btn>
              <Btn tone="stop">Stop</Btn>
              <Btn tone="ghost">Generate</Btn>
              <Btn tone="ai">Debug with AI</Btn>
            </Row>
            <Row label="disabled">
              <Btn tone="go" disabled>
                Run test
              </Btn>
              <Btn tone="ghost" disabled>
                Generate
              </Btn>
            </Row>
          </div>
        </Panel>

        <Panel title="ToolTile" id="mark, name, and what it does" pad={12}>
          {/* The trainer action bar's tile (Direction A). Folded is the strip's
              steady state and the 360px panel's only one; unfolded is the
              posture that teaches. The fold is passed to every tile at once —
              a strip where one tile is tall reflows mid-reach. */}
          <div style={{ display: "grid", gap: 10 }}>
            <Row label="folded strip">
              <div style={{ display: "flex", gap: 6, width: 340 }}>
                <ToolTile folded caret mark={<CheckSquare />} name="Assert" what="Pin what must be true on the page" />
                <ToolTile folded caret mark={<Plus />} name="Add step" what="Insert a manual step at the cursor" />
                <ToolTile folded mark={<RotateCcw />} name="Replay" what="Re-run from the selected step" />
                <ToolTile folded tone="ai" mark={<Wand2 />} name="AI" what="Describe steps in words" />
              </div>
            </Row>
            <Row label="unfolded">
              <div style={{ display: "flex", gap: 6, width: 420 }}>
                <ToolTile caret mark={<CheckSquare />} name="Assert" what="Pin what must be true" />
                <ToolTile tone="ai" mark={<Wand2 />} name="AI" what="Describe steps in words" />
              </div>
            </Row>
            <Row label="disabled">
              <div style={{ display: "flex", gap: 6, width: 340 }}>
                <ToolTile folded caret disabled mark={<CheckSquare />} name="Assert" what="Pin what must be true" />
                <ToolTile folded disabled tone="ai" mark={<Wand2 />} name="AI" what="Describe steps in words" />
              </div>
            </Row>
          </div>
        </Panel>

        <Panel
          title="StatusChip"
          id="one edge, whatever the word"
          pad={12}
          right={<TypeChip type="assert" />}
        >
          {/* The fixed-width contract, made visible: these are stacked so the
              trailing edge is a single line. A chip sized to its content would
              be obvious here and nowhere else. */}
          <div style={{ display: "grid", gap: 4, justifyItems: "start" }}>
            <StatusChip tone="phos">Passed</StatusChip>
            <StatusChip tone="red">Failed</StatusChip>
            <StatusChip tone="amber">Healed</StatusChip>
            <StatusChip running animated>
              Running
            </StatusChip>
            <StatusChip>Never</StatusChip>
            {/* The chip AS a control — the trainer's Recording/Paused chip is
                a real <button> that toggles the state it reports. Rendered
                here in both states because hover/focus affordances exist
                nowhere jsdom can see them. */}
            <StatusChip running animated onClick={() => {}} title="Pause recording (⌘R)">
              Recording
            </StatusChip>
            <StatusChip onClick={() => {}} title="Resume recording (⌘R)">
              Paused
            </StatusChip>
          </div>
        </Panel>

        <Panel title="Hint" id="hover and focus, never a native title" pad={12}>
          {/* The theme's tooltip. Tab to the control as well as hovering it:
              focus opens the same words, which is the half a native `title`
              never had — and the half macOS under the pinned Electron shows
              once and then rarely (electron/electron#49843). */}
          <Row label="on a control">
            <ChromeButton label="Open Settings">
              <span aria-hidden="true">⚙</span>
            </ChromeButton>
            <Hint text="Only the pixels that changed" side="right">
              <button type="button" className="gl-segmented-item" aria-pressed="false">
                Diff
              </button>
            </Hint>
          </Row>
          <Row label="on text">
            <Hint text="run-2026-08-08-a-very-long-identifier-that-truncates" side="bottom">
              <span className="gl-panel-id" style={{ maxWidth: 160 }}>
                run-2026-08-08-a-very-long-identifier-that-truncates
              </span>
            </Hint>
          </Row>
        </Panel>
        <Panel title="Segmented" id="selection is neutral" pad={12}>
          <div style={{ display: "grid", gap: 10 }}>
            <Row label="compare">
              <Segmented
                label="Compare mode"
                value={seg}
                onChange={setSeg}
                options={[
                  { value: "current", label: "Current" },
                  { value: "baseline", label: "Baseline" },
                  { value: "diff", label: "Diff", title: "Only the pixels that changed" },
                ]}
              />
            </Row>
            <Row label="beside status">
              {/* The point of the rule: the active segment must not compete
                  with the chip next to it. */}
              <Segmented
                label="Scope"
                value={seg}
                onChange={setSeg}
                options={[
                  { value: "current", label: "Page" },
                  { value: "diff", label: "Element" },
                ]}
              />
              <StatusChip tone="red">Failed</StatusChip>
            </Row>
          </div>
        </Panel>

        <Panel
          title="Temp"
          id="deviation from this test's own median"
          pad={12}
          right={
            <Segmented
              label="Temp mode"
              value={mode}
              onChange={(m) => setMode(m as TempMode as typeof mode)}
              options={[
                { value: "tint", label: "Tint" },
                { value: "rule", label: "Rule" },
                { value: "bar", label: "Bar" },
                { value: "delta", label: "Delta" },
                { value: "halo", label: "Halo" },
              ]}
            />
          }
        >
          <div style={{ display: "grid", gap: 12 }}>
            {/* The ramp, sampled. The middle three must be visibly identical —
                that dead band is the whole design. */}
            <Row label="ramp">
              {[-0.6, -0.3, -0.05, 0, 0.05, 0.2, 0.35, 0.6, 1.4].map((dev) => (
                <Temp key={dev} ms={Math.round(1000 * (1 + dev))} median={1000} mode={mode} />
              ))}
            </Row>
            <Row label="no median">
              <Temp ms={1200} mode={mode} />
            </Row>
          </div>
        </Panel>

        <Panel title="TypeChip" id="16 step types" pad={12}>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {ALL_TYPES.map((t) => (
              <TypeChip key={t} type={t} />
            ))}
          </div>
        </Panel>

        <Panel title="StepRow" id="status is an inset rail" pad={0}>
          <div>
            <InsertGap index={0} active={cursor === 0} onInsert={setCursor} label="Insert at start" />
            <StepRow
              index={1}
              type="goto"
              description="Go to https://shop.example.com"
              tone="phos"
              ms={820}
              median={900}
            />
            <InsertGap index={1} active={cursor === 1} onInsert={setCursor} label="Insert after 1" />
            <StepRow
              index={2}
              type="fill"
              description="Fill the email field with someone@example.com"
              tone="phos"
              selected
              ms={140}
              median={130}
            />
            <InsertGap index={2} active={cursor === 2} onInsert={setCursor} label="Insert after 2" />
            <StepRow index={3} type="if" description="If the cookie banner is visible" tone="phos" />
            <StepRow
              index={4}
              type="click"
              description="Click Accept"
              tone="amber"
              indent={1}
              ms={2400}
              median={900}
            />
            <StepRow index={5} type="endif" description="End if" tone="phos" indent={1} />
            {/* Selected AND failing — the case both treatments have to survive. */}
            <StepRow
              index={6}
              type="assert"
              description="Expect the order summary to contain 'Thank you'"
              tone="red"
              selected
              ms={5100}
              median={900}
            />
            <StepRow index={7} type="wait" description="Wait for the receipt" />
          </div>
        </Panel>

        <Panel title="Verdict" id="the only sans on the screen" pad={12}>
          <div style={{ display: "grid", gap: 12 }}>
            <Verdict tone="red" detail="The button moved into a dialog on 2026-08-06.">
              The locator matched nothing, so the click never happened.
            </Verdict>
            <Verdict tone="amber">
              A heal that succeeded is not the same as a heal that was right.
            </Verdict>
            <Verdict tone="phos">Everything this test claims still holds.</Verdict>
          </div>
        </Panel>

        <Panel
          title="CRT"
          id="content is never treated"
          pad={12}
          right={
            <Btn tone="ghost" onClick={() => setCrt((v) => !v)}>
              {crt ? "CRT on" : "CRT off"}
            </Btn>
          }
        >
          {/* Toggle the overlay above and watch the page take scanlines while
              this frame does not. That is z-610 doing its job. */}
          <CRT caption="Baseline · chromium · 1280×800">
            <div
              style={{
                display: "grid",
                placeItems: "center",
                height: 132,
                background: "#ffffff",
                color: "#111",
                fontFamily: "var(--gl-sans)",
                fontSize: 13,
              }}
            >
              a captured frame — this white must stay white
            </div>
          </CRT>
        </Panel>

        <Panel title="KeyValue" id="baseline-aligned" pad={12}>
          <KeyValue
            labelWidth={104}
            rows={[
              { label: "Run", value: "run-2026-08-08-14" },
              { label: "Browser", value: "chromium" },
              { label: "Viewport", value: "1280×800" },
              { label: "Status", value: <StatusChip tone="phos">Passed</StatusChip> },
              { label: "Accepted by", value: "chris", title: "chris@example.com" },
            ]}
          />
        </Panel>

        <Panel title="Calendar" id="the horizon is a disabled edge, not an absence" pad={12}>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-start" }}>
            <Calendar
              label="Choose a date"
              value={calDay}
              today={CAL_TODAY}
              min={CAL_TODAY}
              max={new Date(2029, 7, 17, 23, 59, 59, 999).getTime()}
              onChange={setCalDay}
            />
            {/* A one-week window, so the disabled edge and both dead month
                buttons are on screen at once — the states the bounded case is
                actually built for, and the ones a default month never shows. */}
            <Calendar
              label="Choose a date, tightly bounded"
              value={new Date(2026, 7, 19).getTime()}
              today={CAL_TODAY}
              min={CAL_TODAY}
              max={new Date(2026, 7, 21).getTime()}
              onChange={() => {}}
            />
          </div>
        </Panel>

        <Panel title="MenuItem" id="each option states its trade-off" pad={0}>
          <div>
            <MenuItem label="1" consequence="Slowest, and the only setting that never lies to you." />
            <MenuItem
              label="4"
              selected
              consequence="A good default on a machine with headroom to spare."
            />
            <MenuItem
              label="8"
              consequence="A laptop will thrash and report failures it caused."
            />
            <MenuItem label="Delete test" danger consequence="The spec and its run history go too." />
          </div>
        </Panel>

        {/* The dialog footer at the width it broke at. The trainer panel is 360
            DIP, so its dialog is `w-[calc(100vw-4rem)]` = 296px with 264px of
            content — and this is the ONLY place that can be looked at, because
            the main window has a 928px floor and the dialog is roomy there.
            The dashed rule is the panel's content edge: before `flex-wrap`,
            the destructive button was laid out to the LEFT of it. */}
        <Panel title="DialogActions" id="264px of content, no escaping it" pad={12}>
          <div style={{ display: "grid", gap: 14, justifyItems: "start" }}>
            <Row label="shipped">
              <PanelWidthBox>
                <DialogActions
                  onConfirm={() => {}}
                  confirmLabel="Save & Exit"
                  destructiveAction={{ label: "Discard Edits", onClick: () => {} }}
                />
              </PanelWidthBox>
            </Row>
            {/* A third button is allowed — it costs a row, not the page behind
                the dialog. This is the exact set that used to overflow. */}
            <Row label="+ a 3rd button">
              <PanelWidthBox>
                <DialogActions
                  onConfirm={() => {}}
                  confirmLabel="Save & Exit"
                  destructiveAction={{ label: "Discard Edits", onClick: () => {} }}
                  secondaryAction={{ label: "Cancel", onClick: () => {} }}
                />
              </PanelWidthBox>
            </Row>
            {/* Opened from state rather than the `trigger` prop, which is how
                every real caller drives this dialog too — the trainer raises it
                from `exitOpen`, not from a button inside it. */}
            <Row label="the real one">
              <Button variant="muted" onClick={() => setExitOpen(true)}>
                Open exit dialog
              </Button>
              <Dialog
                open={exitOpen}
                onOpenChange={setExitOpen}
                title="Save changes to this test?"
                description="You have unsaved edits to this test's steps. Save them, or discard your edits and exit."
                confirmLabel="Save & Exit"
                onConfirm={() => {}}
                destructiveAction={{ label: "Discard Edits", onClick: () => {} }}
              >
                <span style={{ fontSize: 12, color: "var(--gl-tx-2)" }}>
                  Portalled and modal — narrow the window to 360px to see it at the trainer
                  panel&rsquo;s width. Dismissed by the X, Escape or the overlay; there is no
                  Cancel button.
                </span>
              </Dialog>
            </Row>
          </div>
        </Panel>

        {/* Inside a `.gl-run-panel` because that is what the panels sit in, and
            their padding and dividers are set against its edges. */}
        <Panel title="Run summaries" id="§6.1 — five states" pad={0}>
          <div className="gl-run-panel" style={{ flex: "0 0 auto" }}>
            {RUN_SUMMARIES.map((summary, i) => (
              <RunSummaryPanel key={i} summary={summary} onReview={() => {}} />
            ))}
          </div>
        </Panel>

        {/* THE ONLY PLACE THE EVIDENCE FIGURE CAN BE SEEN LIT. The dom suite
            runs with `css: false`, so the spotlight — a 100vmax box-shadow the
            stage clips to the shot — and the one-shot settle animation exist
            only here. The box sits over the frame's own drawn button, so a
            geometry mistake reads as a box around nothing. Three states:
            measured (solid, spotlight, settles once), approximate (dashed, no
            spotlight — the box is a hint, not a measurement), and no box at
            all, which is an acceptable state and must read as a screenshot
            rather than a broken figure. */}
        <Panel title="ShotHighlight" id="the box is the claim" pad={12}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {SHOT_HIGHLIGHT_SPECIMENS.map(({ key, node }) => (
              <div key={key} style={{ flex: "1 1 240px", maxWidth: 320 }}>
                {node}
              </div>
            ))}
          </div>
        </Panel>

        {/* THE ONLY PLACE THE BRANCH FLYOUT CAN BE SEEN. The rail row it hangs
            off renders only when the branch switcher is available, and it never
            is in a browser tab — the preview has no git, no build and no way to
            relaunch anything, and it says so rather than pretending (see
            `preview-bridge.ts`). So the menu is mounted here directly, against a
            fixture, in the states worth looking at: with pull requests, without,
            and while a branch build is running. Placement and clipping are the
            things jsdom cannot check, and this is where to check them. */}
        <Panel title="Branch flyout" id="hover the row →" pad={12}>
          <div style={{ display: "grid", gap: 16 }}>
            {BRANCH_MENU_SPECIMENS.map(({ label, input }) => (
              <div key={label} style={{ display: "grid", gap: 6 }}>
                <span
                  style={{
                    fontFamily: "var(--gl-mono)",
                    fontSize: 9,
                    letterSpacing: "var(--gl-track-label)",
                    textTransform: "uppercase",
                    color: "var(--gl-tx-3)",
                  }}
                >
                  {label}
                </span>
                {/* In a `.gl-rail` at the real rail width, because the panel is
                    positioned from the row's own rect and a row measured at
                    some other width lands somewhere the app never would. */}
                <div className="gl-rail" style={{ width: 232, height: 44 }}>
                  <div className="gl-rail-nav">
                    <RailFlyout
                      label="Branches"
                      panel={
                        <BranchMenu
                          model={buildBranchMenu(input)}
                          onChoose={() => {}}
                          onSeeAll={() => {}}
                        />
                      }
                    >
                      {(trigger) => (
                        <RailRow
                          {...trigger}
                          icon={<GitBranch aria-hidden="true" />}
                          title="Branches"
                          subtitle="Run a PR of this app"
                        />
                      )}
                    </RailFlyout>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="SiteIcon + TagStack" id="monogram by default" pad={12}>
          <div style={{ display: "grid", gap: 10 }}>
            {["shop.example.com", "docs.example.com", "app.example.com", "localhost", "10.0.0.4"].map(
              (host) => (
                <Row key={host} label={host}>
                  <SiteIcon host={host} size={18} />
                  <TagStack
                    tags={["checkout", "smoke", "critical", "payments", "regression"]}
                    onOpen={() => {}}
                  />
                </Row>
              ),
            )}
          </div>
        </Panel>
      </div>
    </>
  );
}
