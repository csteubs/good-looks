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
  InsertGap,
  KeyValue,
  MenuItem,
  Panel,
  Segmented,
  SiteIcon,
  StatusChip,
  StepRow,
  TagStack,
  Temp,
  TypeChip,
  Verdict,
} from "../theme";
import type { TempMode } from "../theme";
import type { StepType } from "../lib/recorder-types";

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
          </div>
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
