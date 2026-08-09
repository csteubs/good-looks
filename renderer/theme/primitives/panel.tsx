// Panel — the bordered section that every screen is built out of.
//
// A hairline box over `--gl-panel`, optionally with a 32px header. There is no
// elevation and no shadow, because in this design depth is read from WHICH
// near-black a surface is rather than from how far it appears to float.
//
// THE HEADER HEIGHT IS FIXED at 32px for the same reason `--gl-status-w` is
// fixed: two panels side by side must start their bodies on the same line, and
// a header that grows with its content breaks that one panel at a time.
//
// The `id` slot is the part worth explaining. Panels in this app are almost
// always ABOUT something — a test, a run, a host — and the design puts that
// reference next to the title, dim and truncating. It is deliberately not part
// of the title: a heading that changes length with its subject makes a column
// of panels ragged, and the reference is something you look for rather than
// something you read.

import * as React from "react";

export interface PanelProps {
  /** Uppercase heading. Omit it and the panel has no header at all. */
  title?: string;
  /** What this panel is about — a test id, a run id, a host. Dim, truncating. */
  id?: string;
  /** Controls, pinned to the trailing edge of the header. */
  right?: React.ReactNode;
  /** Body padding in px. `true` means the default 10. */
  pad?: number | boolean;
  /** Let the panel grow to fill its flex parent. */
  flex?: boolean;
  /** Cap the BODY's height and scroll it, leaving the header pinned. Capping
   *  the panel instead would scroll the header away, which is how a long list
   *  loses the control that filters it. */
  bodyMax?: number;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

export function Panel({
  title,
  id,
  right,
  pad,
  flex,
  bodyMax,
  className,
  style,
  children,
}: PanelProps): React.ReactElement {
  const padding = pad === true ? 10 : pad === false || pad === undefined ? undefined : pad;
  const hasHeader = title !== undefined || id !== undefined || right !== undefined;

  return (
    <section
      className={["gl-panel", className].filter(Boolean).join(" ")}
      style={{ ...(flex ? { flex: "1 1 auto" } : null), ...style }}
      data-gl="panel"
    >
      {hasHeader ? (
        <header className="gl-panel-head">
          {title !== undefined ? <span className="gl-panel-title">{title}</span> : null}
          {id !== undefined ? (
            // `title` attribute rather than a Tooltip: Radix tooltips cannot be
            // opened under jsdom, and a truncated id is exactly the thing
            // someone needs the full text of.
            <span className="gl-panel-id" title={id}>
              {id}
            </span>
          ) : null}
          {right !== undefined ? <div className="gl-panel-right">{right}</div> : null}
        </header>
      ) : null}
      <div
        className="gl-panel-body"
        style={{
          ...(padding !== undefined ? { padding } : null),
          ...(bodyMax !== undefined ? { maxHeight: bodyMax } : null),
          ...(flex ? { flex: "1 1 auto" } : null),
        }}
      >
        {children}
      </div>
    </section>
  );
}
