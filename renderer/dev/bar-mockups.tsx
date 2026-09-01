// The action-bar mockup lab — `/?view=bar-lab`.
//
// Three candidate directions for the trainer tool-row reorganisation, each
// rendered at main-pane width AND inside a 360px box, across the session
// states that historically reflowed the row (armed assert, replay, refine,
// selection, an agent run, the opt-in suggestion strip). Mounted INSTEAD of
// the app the way the specimen is; nothing here ships (renderer/dev/ is
// preview-only) and nothing here is wired — every handler flips local state.
//
// Class discipline: everything lab-owned wears a `mock-` prefix. A `gl-*`
// name appearing here is a REAL one, imported so a frame's chrome matches the
// app; the lab mints no gl- classes and no --gl-* properties, because
// check:renderer-classes audits that namespace against the production sheet.
//
// Deep links for screenshots: `?view=bar-lab&dir=b&state=armed&soft=1&suggest=1`.

import * as React from "react";
import {
  CheckSquare,
  ChevronDown,
  Crosshair,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Wand2,
  Workflow,
  X,
} from "lucide-react";

import { Btn, Segmented, StatusChip } from "../theme";

import "./bar-mockups.css";

/* ── the state matrix every direction must survive ─────────────────────── */

type LabState = "idle" | "armed" | "replaying" | "refine" | "selection" | "agent";

const STATES: ReadonlyArray<{ value: LabState; label: string }> = [
  { value: "idle", label: "Idle" },
  { value: "armed", label: "Armed assert" },
  { value: "replaying", label: "Replaying" },
  { value: "refine", label: "Refine" },
  { value: "selection", label: "Selection" },
  { value: "agent", label: "Agent run" },
];

/** Everything a direction needs to draw one frame. */
interface FrameCtx {
  state: LabState;
  soft: boolean;
  setSoft: (v: boolean) => void;
  suggestions: boolean;
  narrow: boolean;
}

const disabled = (s: LabState): boolean => s === "replaying" || s === "agent";

/* ── shared scenery ─────────────────────────────────────────────────────── */

/** Four rows echoing the t-checkout fixture — scenery, not the subject. */
const STEP_LABELS = [
  ["goto", "https://shop.example.com"],
  ["click", "button “Add to cart”"],
  ["fill", "label “Email” → buyer@example.com"],
  ["click", "button “Place order”"],
] as const;

function MockSteps({ selected }: { selected: boolean }): React.ReactElement {
  return (
    <div className="mock-steps">
      {STEP_LABELS.map(([kind, rest], i) => (
        <div key={kind + rest} className={i >= 1 && selected ? "mock-step mock-step-selected" : "mock-step"}>
          <span className="mock-step-kind">{kind}</span>
          <span className="mock-step-rest">{rest}</span>
        </div>
      ))}
      <div className="mock-caret">insert here ─────────</div>
    </div>
  );
}

function StatusRow({ state }: { state: LabState }): React.ReactElement {
  return (
    <div className="gl-trainer-status">
      {state === "replaying" || state === "agent" ? (
        <StatusChip running animated>
          {state === "agent" ? "Agent" : "Replaying"}
        </StatusChip>
      ) : (
        <StatusChip running animated>
          Recording
        </StatusChip>
      )}
      <span className="gl-mono-value min-w-0 truncate">https://shop.example.com/cart</span>
    </div>
  );
}

function SuggestStrip({ narrow }: { narrow: boolean }): React.ReactElement {
  return (
    <div className="mock-suggest">
      <Sparkles className="size-3 mock-suggest-mark" aria-hidden />
      <button type="button" className="mock-chip">
        Assert “Order placed” is visible
      </button>
      {narrow ? null : (
        <button type="button" className="mock-chip">
          Assert URL contains /confirmation
        </button>
      )}
      <span className="mock-suggest-tag">AI · opt-in</span>
    </div>
  );
}

function AgentPane({ narrow }: { narrow: boolean }): React.ReactElement {
  return (
    <div className="mock-agent">
      <div className="mock-agent-goal">
        <Wand2 className="size-3.5" aria-hidden />
        <span className="mock-agent-goal-text">“add an item to the cart and check out”</span>
        <Btn tone="stop" className="ml-auto">
          <Square className="size-3.5" /> Stop
        </Btn>
      </div>
      <div className="mock-agent-log">
        <div className="mock-agent-line mock-agent-ok">✓ click · button “Add to cart” — verified, inserted</div>
        <div className="mock-agent-line mock-agent-ok">✓ click · link “Cart” — verified, inserted</div>
        <div className="mock-agent-line mock-agent-live">… trying click · button “Checkout” (attempt 2 — first locator matched 0)</div>
      </div>
      <div className="mock-proposal">
        <span className="mock-proposal-text">Proposed assertion: “Cart total” is visible</span>
        <span className={narrow ? "mock-proposal-acts mock-proposal-acts-wrap" : "mock-proposal-acts"}>
          <Btn tone="go">Accept</Btn>
          <Btn>Dismiss</Btn>
        </span>
      </div>
    </div>
  );
}

/** The transient content of a reserved context area — one implementation,
 *  because directions A and B share the concept and the mock should let the
 *  user compare the FRAME, not two accidental copies of the content. */
function ContextContent({ state, soft, setSoft, narrow }: FrameCtx): React.ReactElement {
  switch (state) {
    case "armed":
      return (
        <>
          <span className="gl-trainer-prompt">Has exact text — click an element in the browser…</span>
          <Segmented
            label="Assertion strictness"
            value={soft ? "soft" : "hard"}
            onChange={(v) => setSoft(v === "soft")}
            options={[
              { value: "hard", label: "Hard" },
              { value: "soft", label: "Soft" },
            ]}
          />
          <button type="button" className="gl-icon-btn" aria-label="Cancel assertion">
            <X className="size-3.5" />
          </button>
        </>
      );
    case "replaying":
      return <span className="mock-context-note">Replaying from step 2 — controls pause until it lands.</span>;
    case "refine":
      return (
        <>
          <Crosshair className="size-3.5 mock-refine-mark" aria-hidden />
          <span className="gl-trainer-prompt">Pick the component this step should target.</span>
          <button type="button" className="gl-icon-btn ml-auto" aria-label="Cancel selector refine">
            <X className="size-3.5" />
          </button>
        </>
      );
    case "selection":
      return (
        <>
          <span className="mock-context-note">3 steps selected</span>
          <Btn>
            <Workflow className="size-3.5" /> {narrow ? "Flow (3)" : "Create flow (3)"}
          </Btn>
        </>
      );
    case "agent":
      return <span className="mock-context-note">Agent is driving the page — steps land in the list as they verify.</span>;
    default:
      return <span className="mock-context-hint">Ready — act on the page, or pick a tool.</span>;
  }
}

/* ── Direction A — ToolTiles (REDESIGN §B6 adapted) ─────────────────────── */

const TILES = [
  { mark: CheckSquare, name: "Assert", what: "Pin what must be true", caret: true },
  { mark: Plus, name: "Add step", what: "Insert a manual step", caret: true },
  { mark: RotateCcw, name: "Replay", what: "Re-run from the cursor", caret: false },
  { mark: Wand2, name: "AI", what: "Describe steps in words", caret: false },
] as const;

function DirectionA(ctx: FrameCtx): React.ReactElement {
  const { state, narrow, suggestions } = ctx;
  const [folded, setFolded] = React.useState(narrow);
  const gate = disabled(state);
  return (
    <div className="mock-bar">
      <div className={folded || narrow ? "mock-tiles mock-tiles-folded" : "mock-tiles"}>
        {TILES.map((t) => (
          <button
            key={t.name}
            type="button"
            className="mock-tile"
            disabled={gate}
            title={t.what}
            onClick={() => {
              if (!narrow) setFolded((f) => !f);
            }}
          >
            <t.mark className="size-3.5 mock-tile-mark" aria-hidden />
            <span className="mock-tile-name">{t.name}</span>
            {folded || narrow ? null : <span className="mock-tile-what">{t.what}</span>}
            {t.caret ? <ChevronDown className="size-3 mock-tile-caret" aria-hidden /> : null}
          </button>
        ))}
      </div>
      {!folded && !narrow && state !== "agent" ? (
        <div className="mock-cmd">
          <Wand2 className="size-3.5 mock-cmd-mark" aria-hidden />
          <input className="mock-cmd-input" placeholder="Tell the trainer what to do…" disabled={gate} />
          <button type="button" className="gl-icon-btn" aria-label="Send" disabled={gate}>
            <Send className="size-3.5" />
          </button>
        </div>
      ) : null}
      <div className="mock-context">
        <ContextContent {...ctx} />
      </div>
      {state === "agent" ? <AgentPane narrow={narrow} /> : null}
      {suggestions && state !== "agent" ? <SuggestStrip narrow={narrow} /> : null}
    </div>
  );
}

/* ── Direction B — two-zone bar ─────────────────────────────────────────── */

function DirectionB(ctx: FrameCtx): React.ReactElement {
  const { state, narrow, suggestions } = ctx;
  const gate = disabled(state);
  return (
    <div className="mock-bar">
      <div className="mock-primary">
        <Btn disabled={gate}>
          <CheckSquare className="size-3.5" /> {narrow ? null : "Assert"} <ChevronDown className="size-3" />
        </Btn>
        <Btn disabled={gate}>
          <Plus className="size-3.5" /> {narrow ? null : "Add step"} <ChevronDown className="size-3" />
        </Btn>
        <Btn disabled={gate} aria-label="Replay from the current step">
          <RotateCcw className="size-3.5" /> {narrow ? null : "Replay"}
        </Btn>
        <Btn tone="ai" disabled={gate} aria-label="AI">
          <Wand2 className="size-3.5" /> {narrow ? null : "AI"}
        </Btn>
      </div>
      <div className="mock-context">
        <ContextContent {...ctx} />
        {state === "idle" || state === "replaying" ? (
          <span className="mock-context-end">
            <Btn disabled title="Select two or more adjacent steps first">
              <Workflow className="size-3.5" /> {narrow ? "Flow" : "Create flow"}
            </Btn>
          </span>
        ) : null}
      </div>
      {state === "agent" ? (
        <AgentPane narrow={narrow} />
      ) : (
        <div className="mock-cmd mock-cmd-collapsible">
          <Wand2 className="size-3.5 mock-cmd-mark" aria-hidden />
          <input className="mock-cmd-input" placeholder={narrow ? "Tell the trainer…" : "Tell the trainer what to do — it verifies before it inserts"} disabled={gate} />
          <button type="button" className="gl-icon-btn" aria-label="Send" disabled={gate}>
            <Send className="size-3.5" />
          </button>
        </div>
      )}
      {suggestions && state !== "agent" ? <SuggestStrip narrow={narrow} /> : null}
    </div>
  );
}

/* ── Direction C — command-box-first ────────────────────────────────────── */

function DirectionC(ctx: FrameCtx): React.ReactElement {
  const { state, soft, setSoft, narrow, suggestions } = ctx;
  const gate = disabled(state);
  const cluster = (
    <span className="mock-spine-cluster">
      <button type="button" className="gl-icon-btn" aria-label="Add assertion" disabled={gate}>
        <CheckSquare className="size-3.5" />
      </button>
      <button type="button" className="gl-icon-btn" aria-label="Add step" disabled={gate}>
        <Plus className="size-3.5" />
      </button>
      <button type="button" className="gl-icon-btn" aria-label="Replay from the current step" disabled={gate}>
        <RotateCcw className="size-3.5" />
      </button>
      <button type="button" className="gl-icon-btn" aria-label="More tools" disabled={gate}>
        <MoreHorizontal className="size-3.5" />
      </button>
    </span>
  );
  return (
    <div className="mock-bar">
      <div className={narrow ? "mock-spine mock-spine-narrow" : "mock-spine"}>
        <Wand2 className="size-3.5 mock-cmd-mark" aria-hidden />
        {state === "armed" ? (
          <span className="mock-spine-armed">
            <span className="gl-trainer-prompt">Has exact text — click an element…</span>
            <Segmented
              label="Assertion strictness"
              value={soft ? "soft" : "hard"}
              onChange={(v) => setSoft(v === "soft")}
              options={[
                { value: "hard", label: "Hard" },
                { value: "soft", label: "Soft" },
              ]}
            />
            <button type="button" className="gl-icon-btn" aria-label="Cancel assertion">
              <X className="size-3.5" />
            </button>
          </span>
        ) : state === "replaying" ? (
          <span className="mock-context-note">Replaying from step 2…</span>
        ) : state === "refine" ? (
          <span className="mock-spine-armed">
            <Crosshair className="size-3.5 mock-refine-mark" aria-hidden />
            <span className="gl-trainer-prompt">Pick the component this step should target.</span>
            <button type="button" className="gl-icon-btn" aria-label="Cancel selector refine">
              <X className="size-3.5" />
            </button>
          </span>
        ) : state === "agent" ? (
          <span className="mock-context-note mock-agent-live">… trying click · button “Checkout” (attempt 2)</span>
        ) : (
          <input
            className="mock-cmd-input"
            placeholder={narrow ? "Tell the trainer — or click the page" : "Tell the trainer what to do — or click the page"}
            disabled={gate}
          />
        )}
        {narrow ? null : cluster}
      </div>
      {narrow ? <div className="mock-spine-row2">{cluster}</div> : null}
      {state === "selection" ? (
        <div className="mock-context">
          <ContextContent {...ctx} />
        </div>
      ) : null}
      {state === "agent" ? <AgentPane narrow={narrow} /> : null}
      {suggestions && state !== "agent" ? <SuggestStrip narrow={narrow} /> : null}
    </div>
  );
}

/* ── the lab page ───────────────────────────────────────────────────────── */

interface Direction {
  id: "a" | "b" | "c";
  title: string;
  thesis: string;
  render: (ctx: FrameCtx) => React.ReactElement;
}

const DIRECTIONS: ReadonlyArray<Direction> = [
  {
    id: "a",
    title: "Direction A — ToolTiles",
    thesis:
      "REDESIGN §B6 adapted: four named tiles pinned above the list, folded to a strip by default; every transient lives in one fixed context line, so nothing reflows. At 360px the tiles are the icon strip the panel already has.",
    render: DirectionA,
  },
  {
    id: "b",
    title: "Direction B — two-zone bar",
    thesis:
      "A primary row whose membership and widths never change, over a morphing context zone with reserved height. The command box docks beneath. At 360px this is the panel's existing band architecture, gaining Hard/Soft and the box.",
    render: DirectionB,
  },
  {
    id: "c",
    title: "Direction C — command-box-first",
    thesis:
      "The AI input is the bar's spine; classic actions compress to an icon cluster at its end, rare ones behind an overflow. The box doubles as the context zone. Boldest: tests whether the agent should be the default posture.",
    render: DirectionC,
  },
];

function Frame({
  dir,
  narrow,
  state,
  soft,
  setSoft,
  suggestions,
}: {
  dir: Direction;
  narrow: boolean;
  state: LabState;
  soft: boolean;
  setSoft: (v: boolean) => void;
  suggestions: boolean;
}): React.ReactElement {
  return (
    <div className={narrow ? "mock-frame mock-frame-narrow" : "mock-frame"}>
      <div className="mock-frame-tag">{narrow ? "docked panel · 360px" : "main window"}</div>
      <StatusRow state={state} />
      <MockSteps selected={state === "selection"} />
      {dir.render({ state, soft, setSoft, suggestions, narrow })}
    </div>
  );
}

function DirectionSection({
  dir,
  initialState,
  initialSoft,
  initialSuggest,
}: {
  dir: Direction;
  initialState: LabState;
  initialSoft: boolean;
  initialSuggest: boolean;
}): React.ReactElement {
  const [state, setState] = React.useState<LabState>(initialState);
  const [soft, setSoft] = React.useState(initialSoft);
  const [suggestions, setSuggestions] = React.useState(initialSuggest);
  return (
    <section className="mock-section" data-direction={dir.id}>
      <h2 className="mock-title">{dir.title}</h2>
      <p className="mock-thesis">{dir.thesis}</p>
      <div className="mock-controls">
        <Segmented<LabState> label={`${dir.title} state`} value={state} onChange={setState} options={STATES} />
        <label className="mock-toggle">
          <input type="checkbox" checked={suggestions} onChange={(e) => setSuggestions(e.target.checked)} />
          Suggestion strip (opt-in)
        </label>
      </div>
      <div className="mock-frames">
        <Frame dir={dir} narrow={false} state={state} soft={soft} setSoft={setSoft} suggestions={suggestions} />
        <Frame dir={dir} narrow state={state} soft={soft} setSoft={setSoft} suggestions={suggestions} />
      </div>
    </section>
  );
}

export function BarLab(): React.ReactElement {
  const params = new URLSearchParams(window.location.search);
  const only = params.get("dir");
  const rawState = params.get("state");
  const initialState: LabState = (STATES.find((s) => s.value === rawState)?.value ?? "idle") as LabState;
  const initialSoft = params.get("soft") === "1";
  const initialSuggest = params.get("suggest") === "1";
  const shown = DIRECTIONS.filter((d) => !only || d.id === only);
  return (
    <div className="mock-lab">
      <header className="mock-head">
        <h1 className="mock-h1">Trainer action bar — mockup lab</h1>
        <p className="mock-sub">
          Nothing here is wired. Compare each direction across the states that historically reflowed the row; the second
          frame is the docked panel&rsquo;s 360px. Deep-link a shot with <code>?dir=b&amp;state=armed</code>.
        </p>
      </header>
      {shown.map((d) => (
        <DirectionSection key={d.id} dir={d} initialState={initialState} initialSoft={initialSoft} initialSuggest={initialSuggest} />
      ))}
    </div>
  );
}
