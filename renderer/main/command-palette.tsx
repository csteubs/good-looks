// ⌘K. REDESIGN §6.7 — the first thing in this app that is faster than the rail.
//
// The ranking lives in `renderer/lib/command-palette.ts` and is tested there;
// this file is the overlay and the list of what the app can be asked to do.
//
// A COMBOBOX, NOT A DIALOG, and that is a decision rather than a shortcut. The
// SDK's `Dialog` is kept elsewhere for its focus trap, but a palette has
// exactly one focusable element — the input — and its rows are never tabbed to.
// The pattern for that is `role="combobox"` over a `role="listbox"` with
// `aria-activedescendant`, which is also the only version of this a screen
// reader reads correctly: rows that take focus announce themselves as the
// focused thing and leave the query behind. It is more testable too, since the
// selection is an attribute rather than `document.activeElement`.
//
// WHAT IT CAN DO IS EVERYTHING THE PLAN NAMES except one, and the exception is
// deliberate. Run a test, run a tag, open a view, record, generate, and reach
// the last failure — all of that is the router, the query cache and the
// recorder store, which is why §6.7 called this straightforward. The plan says
// "debug the last failure"; what this OPENS is the failing test, because the AI
// debug session needs the script and the run output that `test-detail-view`
// assembles, and a palette that reached across that boundary to fake the
// context would open a session about the wrong run. The row is named for what
// it does. The sparkle is one click away and already the right colour.
//
// THE TWO DIALOGS ARE MOUNTED HERE, a third time. `home-view.tsx` states the
// reasoning and it holds: both are fully controlled and render nothing while
// closed, so an instance costs one boolean, and hoisting them to a provider
// would put three screens' state in a component that is none of them.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../lib/api";
import {
  clampSelection,
  filterCommands,
  groupCommands,
  moveSelection,
  type Command,
} from "../lib/command-palette";
import { useRecorder } from "./recorder-store";
import { NewRecordingDialog } from "./new-recording-dialog";
import { GenerateTestDialog } from "./generate-test-dialog";

/** The views the palette can reach, in the rail's own order. Kept here rather
 *  than imported from `app-strip.tsx`'s breadcrumb table: that one maps a path
 *  to what the crumb should READ, which is the same string today and answers a
 *  different question — a crumb names where you are, a command names where you
 *  are going, and the day one of them wants "Back to Stats" they diverge. */
const VIEWS: { path: string; label: string; keywords: string }[] = [
  { path: "/", label: "Home", keywords: "start overview" },
  { path: "/stats", label: "Stats", keywords: "run history logs charts flake cost" },
  { path: "/visual", label: "Visual", keywords: "screenshot replay diff baseline" },
  { path: "/batch", label: "Batch", keywords: "run many tests suite" },
  { path: "/heals", label: "Heals", keywords: "auto-heal locators review" },
  { path: "/branches", label: "Branches", keywords: "git worktree build switch" },
];

/** Is this platform's palette key held? ⌘ on a Mac, Ctrl elsewhere — and both
 *  are accepted everywhere rather than sniffed, because the app also runs in a
 *  browser tab under `dev:web` where the answer is whatever the developer's
 *  keyboard is. Accepting both costs nothing: no other shortcut in this app
 *  uses K. */
export function isPaletteChord(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
}

/** Everything the palette can be asked to do, given what the app knows.
 *
 *  ORDER MATTERS AND IS NOT ALPHABETICAL. With an empty query the palette
 *  renders this list as given (see `filterCommands`), so what sits at the top
 *  is what somebody who pressed ⌘K and then nothing at all is offered: record,
 *  generate, and — when there is one — the last failure. */
function useCommands(close: () => void): Command[] {
  const navigate = useNavigate();
  const { run } = useRecorder();
  const queryClient = useQueryClient();
  const [, setRecordOpen] = useDialogOpeners();

  const tests = useQuery({ queryKey: ["tests"], queryFn: api.tests.list }).data;
  const runs = useQuery({ queryKey: ["runs"], queryFn: api.runs.list }).data;

  return React.useMemo(() => {
    const out: Command[] = [];
    const go = (fn: () => void) => () => {
      close();
      fn();
    };

    out.push({
      id: "record",
      title: "Record a test",
      group: "Actions",
      keywords: "new capture train trainer",
      hint: "Trainer",
      run: go(() => setRecordOpen("record")),
    });
    out.push({
      id: "generate",
      title: "Generate from prompt",
      group: "Actions",
      keywords: "ai llm write new",
      hint: "AI",
      run: go(() => setRecordOpen("generate")),
    });

    // The most recent FAILED run of a test that still exists. Tombstoned runs
    // are excluded because every surface that names a test excludes them, and a
    // palette row leading to a deleted test is a dead end wearing a name.
    const lastFailure = (runs ?? [])
      .filter((r) => r.status === "failed" && !r.testDeleted && (r.kind ?? "run") === "run")
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (lastFailure) {
      out.push({
        id: "last-failure",
        // Named for what it DOES. "Debug the last failure" would promise the AI
        // panel, which this cannot open from here — see the header.
        title: `Open the last failure — ${lastFailure.testName}`,
        group: "Actions",
        keywords: `debug failed ${lastFailure.testName}`,
        hint: "Failed",
        run: go(() => navigate({ to: "/test/$id", params: { id: lastFailure.testId } })),
      });
    }

    for (const test of tests ?? []) {
      let host = "";
      try {
        host = new URL(test.url).hostname;
      } catch {
        // A test's URL is whatever was recorded; an unparseable one loses its
        // host as a search term and keeps everything else.
      }
      const tagText = (test.tags ?? []).join(" ");
      out.push({
        id: `open:${test.id}`,
        title: test.name,
        group: "Tests",
        keywords: `${host} ${tagText}`,
        hint: host || undefined,
        run: go(() => navigate({ to: "/test/$id", params: { id: test.id } })),
      });
      out.push({
        id: `run:${test.id}`,
        title: `Run ${test.name}`,
        group: "Tests",
        keywords: `${host} ${tagText} execute`,
        hint: "Run",
        run: go(() => {
          // Navigate FIRST. The run streams its output into the detail view's
          // panel, and starting one the user cannot see is the app doing
          // something invisible on their behalf.
          navigate({ to: "/test/$id", params: { id: test.id } });
          run(test.id, test.captureArtifacts, test.runHeadless, test.runBrowser);
        }),
      });
    }

    // One row per tag, running every test that carries it as a batch. Counted
    // in the hint, because "Run smoke" is a very different proposition at 3
    // tests and at 40 and the palette is the one surface with no list to check.
    const byTag = new Map<string, string[]>();
    for (const test of tests ?? []) {
      for (const tag of test.tags ?? []) {
        byTag.set(tag, [...(byTag.get(tag) ?? []), test.id]);
      }
    }
    for (const [tag, ids] of [...byTag.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push({
        id: `tag:${tag}`,
        title: `Run tag: ${tag}`,
        group: "Tags",
        keywords: "batch suite",
        hint: `${ids.length} ${ids.length === 1 ? "test" : "tests"}`,
        run: go(() => {
          navigate({ to: "/batch" });
          void api.batch
            .run(ids)
            .then(() => queryClient.invalidateQueries({ queryKey: ["batches"] }))
            .catch(() => {
              // Batch refuses a second concurrent run backend-side. The Batch
              // view is already on screen by now and says what is happening
              // there, which is a better answer than a toast from a palette
              // that has closed.
            });
        }),
      });
    }

    for (const view of VIEWS) {
      out.push({
        id: `view:${view.path}`,
        title: view.label,
        group: "Views",
        keywords: view.keywords,
        run: go(() => navigate({ to: view.path })),
      });
    }

    return out;
  }, [tests, runs, navigate, run, close, setRecordOpen, queryClient]);
}

/** Which of the palette's two dialogs is open. A module-level pair of hooks
 *  rather than props, so `useCommands` can stay a hook the component calls
 *  once — threading two setters through it buys nothing and makes the command
 *  list's signature about dialog plumbing. */
type DialogKind = "record" | "generate" | null;
const DialogContext = React.createContext<
  [DialogKind, (kind: DialogKind) => void] | null
>(null);

function useDialogOpeners(): [DialogKind, (kind: DialogKind) => void] {
  const ctx = React.useContext(DialogContext);
  if (!ctx) throw new Error("useDialogOpeners outside CommandPalette");
  return ctx;
}

function PaletteList({
  commands,
  grouped,
  selected,
  onPick,
  onHover,
}: {
  commands: Command[];
  grouped: boolean;
  selected: number;
  onPick: (command: Command) => void;
  onHover: (index: number) => void;
}) {
  // One flat index across every group, because the arrow keys move through the
  // whole list and a per-group index would make Down at the end of a block do
  // nothing visible.
  let index = -1;
  const row = (command: Command) => {
    index += 1;
    const i = index;
    return (
      <li
        key={command.id}
        id={`cmdrow-${command.id}`}
        role="option"
        aria-selected={i === selected}
        className="gl-cmd-row"
        data-selected={i === selected ? "" : undefined}
        // `mouseDown`, not `click`: the input holds focus and a click would
        // blur it first, which on a palette that closes on blur would dismiss
        // the row out from under the pointer.
        onMouseDown={(e) => {
          e.preventDefault();
          onPick(command);
        }}
        onMouseMove={() => onHover(i)}
      >
        <span className="gl-cmd-title">{command.title}</span>
        {command.hint ? <span className="gl-cmd-hint">{command.hint}</span> : null}
      </li>
    );
  };

  return (
    // `cmdrow-` / `cmd-listbox` and NOT the `gl-` prefix, deliberately. `gl-*`
    // is the theme's CLASS namespace, and `check:renderer-classes` audits every
    // `gl-` string the renderer writes by asking the emitted stylesheet whether
    // a rule exists for it — so a DOM id borrowing that prefix reads to the
    // guard as a class that styles nothing. Which it is.
    <ul className="gl-cmd-list" role="listbox" id="cmd-listbox" aria-label="Commands">
      {grouped
        ? groupCommands(commands).map((g) => (
            <React.Fragment key={g.group}>
              {/* `presentation`, not a heading: inside a listbox, anything that
                  is not an option confuses the count a screen reader reads out
                  ("3 of 41"). The blocks are a reading aid for the eye. */}
              <li className="gl-cmd-group" role="presentation">
                {g.group}
              </li>
              {g.commands.map(row)}
            </React.Fragment>
          ))
        : commands.map(row)}
    </ul>
  );
}

/** Open/close, for anything outside the palette that wants to offer it — in
 *  practice the strip's ⌘K key cap. A context rather than a module-level event
 *  bus: the palette is per-window, and a bus would let a second window's cap
 *  open the first window's palette. */
const OpenContext = React.createContext<((open: boolean) => void) | null>(null);

/** Returns null when there is no palette above — the settings window and the
 *  trainer panel have their own roots and no command list to offer. A caller
 *  should render nothing rather than a key cap that answers with silence,
 *  which is the rule `top-strip.tsx` was built around. */
export function useCommandPalette(): ((open: boolean) => void) | null {
  return React.useContext(OpenContext);
}

export function CommandPalette({
  children,
}: {
  children?: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState(0);
  const [dialog, setDialog] = React.useState<DialogKind>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const close = React.useCallback(() => {
    setOpen(false);
    setQuery("");
    setSelected(0);
  }, []);

  // Opening always starts from a blank query. A palette that remembered the
  // last one would make the second ⌘K of a session show a filtered list the
  // user has to clear before it is a palette again.
  const setOpenAndReset = React.useCallback((next: boolean) => {
    setOpen(next);
    setQuery("");
    setSelected(0);
  }, []);

  const dialogValue = React.useMemo<[DialogKind, (kind: DialogKind) => void]>(
    () => [dialog, setDialog],
    [dialog],
  );

  // ⌘K anywhere, INCLUDING inside a field. This is the one shortcut in the app
  // that deliberately does not exempt inputs (`HistoryNav`'s ⌘[ does, because
  // `[` is a character somebody might be typing): ⌘K produces no character,
  // and a palette you cannot open while the cursor is in the log search is a
  // palette you learn not to trust.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPaletteChord(e)) return;
      e.preventDefault();
      setOpen((v) => !v);
      setQuery("");
      setSelected(0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  React.useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  return (
    <OpenContext.Provider value={setOpenAndReset}>
      <DialogContext.Provider value={dialogValue}>
        {children}
        {open ? (
          <PaletteOverlay
            query={query}
            setQuery={setQuery}
            selected={selected}
            setSelected={setSelected}
            close={close}
            inputRef={inputRef}
          />
        ) : null}
        <NewRecordingDialog
          open={dialog === "record"}
          onOpenChange={(o) => setDialog(o ? "record" : null)}
        />
        <GenerateTestDialog
          open={dialog === "generate"}
          onOpenChange={(o) => setDialog(o ? "generate" : null)}
        />
      </DialogContext.Provider>
    </OpenContext.Provider>
  );
}

/** Split out so `useCommands` — which subscribes to two queries — is not
 *  mounted while the palette is closed. ⌘K is global and the palette is shut
 *  almost always; the list is cheap to build and there is no reason to hold
 *  live subscriptions for it in every window all the time. */
function PaletteOverlay({
  query,
  setQuery,
  selected,
  setSelected,
  close,
  inputRef,
}: {
  query: string;
  setQuery: (q: string) => void;
  selected: number;
  setSelected: (n: number) => void;
  close: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const commands = useCommands(close);
  const visible = React.useMemo(() => filterCommands(query, commands), [query, commands]);
  const grouped = query.trim().length === 0;

  // The selection is an INDEX into a list that can change without a keystroke —
  // see `clampSelection` for the case that matters.
  const active = clampSelection(selected, visible.length);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected(moveSelection(active, 1, visible.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(moveSelection(active, -1, visible.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      visible[active]?.run();
    }
  };

  return (
    <div className="gl-cmd-scrim" data-gl="command-palette" onMouseDown={close}>
      {/* Stops a click INSIDE the panel from reaching the scrim's dismiss. */}
      <div className="gl-cmd-panel" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="gl-cmd-input"
          role="combobox"
          aria-expanded
          aria-controls="cmd-listbox"
          aria-activedescendant={
            active >= 0 ? `cmdrow-${visible[active].id}` : undefined
          }
          aria-label="Run a command"
          placeholder="Run a test, open a view, record…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        {visible.length === 0 ? (
          <p className="gl-note gl-cmd-empty">Nothing matches “{query.trim()}”.</p>
        ) : (
          <PaletteList
            commands={visible}
            grouped={grouped}
            selected={active}
            onPick={(c) => c.run()}
            onHover={setSelected}
          />
        )}
      </div>
    </div>
  );
}
