// Documentation — the app's own manual, rendered from the repo's markdown.
//
// The words are NOT written here. `docs/MCP-GUIDE.md` is one document with two
// readers (the repo and this pane), parsed by `renderer/lib/doc-blocks.ts` into
// blocks this file draws. See that file for why a subset parser rather than a
// markdown dependency.
//
// THREE THINGS THIS PANE DOES THAT A RENDERED FILE WOULD NOT:
//
//   • It is reachable by SEARCH. Every topic is indexed by its full text, so
//     typing "webhook" or "flaky" into the settings search finds the passage
//     about it, next to the settings it is about.
//   • It is reachable by DEEP LINK. The Help menu opens the app on a topic
//     (`/settings/documentation/setup`), which is the only reason the slugs in
//     `REQUIRED_TOPIC_SLUGS` are a contract. It used to be the second segment
//     of a URL fragment on a window's own `loadURL`; it is a route param now,
//     and this pane still knows nothing about the router — see the props.
//   • It knows things the document cannot. The setup topic ends with THIS
//     machine's MCP server path and a command that can be copied — a file path
//     nobody should be asked to type, and one the markdown cannot know.
//
// Links: only what `shell.openExternal` will actually open is a link. That
// allowlist is https on github.com and nothing else (main/shell/external-url.ts),
// so every other href — the doc's relative links to other repo files — renders
// as ordinary text. An underlined thing that does nothing when clicked is worse
// than no underline.

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import type { DocBlock, DocSpan, DocTopic } from "../../lib/doc-blocks";
import { APP_DOCS, docRowId } from "../../lib/docs";
import { api } from "../../lib/api";
import { PaneSection } from "../pane-section";
import { useMatchedIds } from "../setting-row";

/** Every topic across every shipped document, flattened — the pane navigates
 *  topics, and which document one came from is a label, not a level. */
const TOPICS: readonly { docLabel: string; topic: DocTopic }[] = APP_DOCS.flatMap((doc) =>
  doc.page.topics.map((topic) => ({ docLabel: doc.label, topic })),
);

const DOC_TITLE = APP_DOCS[0].page.title;

function isOpenableLink(href: string | undefined): href is string {
  return href !== undefined && /^https:\/\/([a-z0-9-]+\.)*github\.com(\/|$)/i.test(href);
}

function Spans({ spans }: { spans: readonly DocSpan[] }) {
  return (
    <>
      {spans.map((span, i) => {
        const text = span.code ? <code className="gl-doc-code">{span.text}</code> : span.text;
        const marked = span.strong ? (
          <strong className="gl-doc-strong">{text}</strong>
        ) : span.em ? (
          <em>{text}</em>
        ) : (
          text
        );
        if (isOpenableLink(span.href)) {
          const href = span.href;
          return (
            <button
              key={i}
              type="button"
              className="gl-doc-link"
              onClick={() => window.glazeAPI.shell.openExternal(href)}
            >
              {marked}
            </button>
          );
        }
        return <span key={i}>{marked}</span>;
      })}
    </>
  );
}

/**
 * A command block, and the two ways a reader takes one away.
 *
 * BOTH OF THEM HAD TO BE BUILT, and the reason is one line in
 * `renderer/styles.css`: `body { user-select: none }`. The app is a native
 * shell rather than a document, so nothing in it is selectable unless it says
 * so — which is right for a step list and wrong for a manual. This pane is the
 * one screen whose whole purpose is text the user is meant to run somewhere
 * else, and the register command is ~130 characters of absolute path. A
 * command you can neither drag a cursor across nor press a button for is one
 * you retype by hand off a screenshot. `.gl-doc-pre` opts back into selection
 * (screens.css); this adds the button.
 *
 * The icon is ALWAYS THERE rather than revealed on hover — same argument as the
 * run panel's expander: a control that only appears once the pointer happens to
 * be over it is one nobody learns is there. It swaps to a tick for a moment,
 * which is the feedback every other copy control in this app gives.
 */
function DocCodeBlock({ text, label = "Copy code" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <div className="gl-doc-codeblock">
      <pre className="gl-doc-pre">
        <code>{text}</code>
      </pre>
      <button
        type="button"
        className="gl-icon-btn gl-doc-copy"
        aria-label={label}
        title={label}
        onClick={() => {
          void window.glazeAPI.clipboard.writeText(text);
          setCopied(true);
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

function Block({ block }: { block: DocBlock }) {
  switch (block.kind) {
    case "heading":
      return <h3 className="gl-doc-h">{block.text}</h3>;
    case "paragraph":
      return (
        <p className="gl-doc-p">
          <Spans spans={block.spans} />
        </p>
      );
    case "quote":
      return (
        <p className="gl-doc-quote">
          <Spans spans={block.spans} />
        </p>
      );
    case "list":
      return (
        <ul className="gl-doc-list">
          {block.items.map((item, i) => (
            <li key={i}>
              <Spans spans={item} />
            </li>
          ))}
        </ul>
      );
    case "code":
      return <DocCodeBlock text={block.text} />;
    case "table":
      // Its own scroller. The settings content column is ~550px and the guide
      // has three-column tables; without this the window itself scrolls
      // sideways and the rail goes with it.
      return (
        <div className="gl-doc-table-wrap">
          <table className="gl-doc-table">
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i}>
                    <Spans spans={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>
                      <Spans spans={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr className="gl-doc-rule" />;
  }
}

/**
 * Where the MCP server actually is on THIS machine, and the command that
 * registers it.
 *
 * The honest version of a copy button: the backend answers from DISK rather
 * than this pane printing a path from documentation.
 *
 * A packaged app carries the server as of R15, so this branch is now the one
 * that fires for everybody. The absent branch is kept because it is still
 * reachable — a dev tree run from a stripped checkout — and because a
 * `build.files` regression should degrade to an honest message rather than a
 * command naming a path that is not there.
 */
function McpServerCard() {
  const [state, setState] = useState<{
    path: string | null;
    exists: boolean;
    command: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.docs
      .mcpServer()
      .then((result) => {
        if (!cancelled) setState(result);
      })
      .catch(() => {
        if (!cancelled) setState({ path: null, exists: false, command: "" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!state) return null;

  return (
    <div className="gl-doc-card">
      <p className="gl-doc-card-label">On this machine</p>
      {state.exists ? (
        <>
          <p className="gl-doc-p">
            The server is at <code className="gl-doc-code">{state.path}</code>. This registers it
            with Claude Code for every project:
          </p>
          {/* One copy affordance on this page, not two. This block used to
              carry a labelled button of its own, which made the machine-specific
              command the only one on the page you could take away — and taught
              the reader that a command without a button underneath it is one to
              retype. Same control as every other block; only the name differs,
              because this is the command about their machine. */}
          <DocCodeBlock text={state.command} label="Copy command" />
        </>
      ) : (
        <p className="gl-doc-p">
          The MCP server is not where this copy of the app expects it
          (<code className="gl-doc-code">{state.path}</code>). A packaged build normally carries it,
          so this usually means the app is running from a source tree that does not have it.
          Register it from a checkout of the project, using the path to its{" "}
          <code className="gl-doc-code">mcp/server.mjs</code>.
        </p>
      )}
    </div>
  );
}

export interface DocumentationPaneProps {
  /** The topic the address names, when there is one.
   *
   *  PROPS RATHER THAN `useParams`, and it is not squeamishness about a hook:
   *  every pane in this directory is a set of controls over the settings
   *  controller and nothing else, which is what lets `panes/*.test.tsx` render
   *  one against a hand-built controller with no router in sight. The routed
   *  wrapper lives beside `PANE_COMPONENTS` in `settings-view.tsx`, where the
   *  rest of this screen's router knowledge already is. */
  topic?: string;
  /** Called when the reader picks another topic. Without it selection is local
   *  state — which is what happens wherever this renders outside the router. */
  onSelectTopic?: (slug: string) => void;
}

export function DocumentationPane({ topic, onSelectTopic }: DocumentationPaneProps = {}) {
  const matched = useMatchedIds();

  // Topics a running search left standing. `null` means no search.
  const visible = useMemo(
    () =>
      matched === null
        ? TOPICS
        : TOPICS.filter(({ topic: t }) => matched.indexOf(docRowId(t.slug)) !== -1),
    [matched],
  );

  // The uncontrolled half. Never written while `onSelectTopic` is supplied, so
  // there is no second answer to "which topic" that could disagree with the
  // address.
  const [local, setLocal] = useState<string>(TOPICS[0].topic.slug);
  const selected = topic ?? local;

  // A search that filters the open topic away moves to one that survived —
  // same rule the pane list follows, for the same reason: a heading over blank
  // space reads as broken search rather than as a narrowed list.
  const current =
    visible.filter(({ topic: t }) => t.slug === selected)[0] ?? visible[0] ?? null;

  if (current === null) return null;

  return (
    <div className="gl-doc">
      <PaneSection title={current.docLabel}>
        {/* Not `role="tab"`. These pick which section of a document is shown,
            which is what a rail of links does — and tabs come with a keyboard
            contract (arrow keys move selection) that plain buttons do not
            honour. `aria-current` is the same announcement `RailRow` makes. */}
        <nav className="gl-doc-toc" aria-label="Topics">
          {visible.map(({ topic: t }) => (
            <button
              key={t.slug}
              type="button"
              id={docRowId(t.slug)}
              aria-current={t.slug === current.topic.slug ? "true" : undefined}
              data-current={t.slug === current.topic.slug ? "" : undefined}
              className="gl-doc-tab"
              onClick={() => (onSelectTopic ? onSelectTopic(t.slug) : setLocal(t.slug))}
            >
              {t.title}
            </button>
          ))}
        </nav>
      </PaneSection>

      <article className="gl-doc-body">
        <p className="gl-doc-eyebrow">{DOC_TITLE}</p>
        <h2 className="gl-doc-title">{current.topic.title}</h2>
        {current.topic.blocks.map((block, i) => (
          <Block key={i} block={block} />
        ))}
        {/* The one place app state is spliced into a document. Deliberately
            after the topic's own words: the guide explains what to register,
            and this says where it is here. */}
        {current.topic.slug === "setup" ? <McpServerCard /> : null}
      </article>
    </div>
  );
}
