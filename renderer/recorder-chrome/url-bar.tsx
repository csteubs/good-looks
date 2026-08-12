// The training browser's URL bar.
//
// This is the app's only owned pixel inside the training browser window. The
// untrusted page lives in a WebContentsView below it (main/services/
// recorder-service.ts), which is the whole reason this can exist — an
// externally-loaded page cannot host an app-owned toolbar, so before the view
// split the trainer's stand-in for an address bar was the native window TITLE,
// and the page won that fight: `document.title` overwrote it on every load, so
// the window said "Ritual" where it was meant to say the URL.
//
// DELIBERATELY NOT EDITABLE. A real address bar would let the user navigate
// mid-session, and a navigation the recorder did not cause is a navigation it
// does not record — the generated spec would then replay a different journey
// than the one on screen, silently. Every navigation in a recording is either
// the opening `goto` step or a consequence of a recorded interaction, and this
// bar reports that rather than adding a way around it. It is selectable and
// copyable because READING the URL was the actual need.

import * as React from "react";
import { Check, Copy, Link2 } from "lucide-react";
import { Button, Text, Tooltip, TooltipContent, TooltipTrigger } from "@ui";

import { api } from "../lib/api";
import type { AssertKind } from "../lib/recorder-types";

/** How long the copy button stays in its confirmed state. Long enough to be
 *  seen, short enough that it is back to normal before the next copy. */
const COPIED_FEEDBACK_MS = 1200;

/** The clipboard bridge, reached through the same global every other window
 *  uses. Typed locally for the same reason `nativeMenu` below is. */
function copyText(text: string): void {
  (
    window as unknown as { glazeAPI: { clipboard: { writeText(t: string): void } } }
  ).glazeAPI.clipboard.writeText(text);
}

export interface UrlBarProps {
  /** The page's live URL. Empty before the first navigation commits. */
  url: string;
  /** Whether the page is mid-load, which is the only progress signal the strip
   *  shows — a determinate bar would be a lie, since Electron reports no
   *  fraction. */
  loading: boolean;
}

/** Split for display: the origin is dimmed so the path — the part that changes
 *  as the user moves through the site, and the part they are about to assert
 *  on — is what the eye lands on. Returns the whole string as `rest` when the
 *  URL does not parse, so an odd scheme still renders legibly. */
export function splitForDisplay(url: string): { origin: string; rest: string } {
  if (!url) return { origin: "", rest: "" };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { origin: "", rest: url };
    }
    return {
      origin: parsed.origin,
      rest: parsed.pathname + parsed.search + parsed.hash,
    };
  } catch {
    return { origin: "", rest: url };
  }
}

/** The assert kinds this bar offers, in the order the menu shows them. Same
 *  three the main window's assert menu carries — the point is that the user no
 *  longer has to leave the page to reach them. */
const URL_ASSERTS: ReadonlyArray<{ kind: AssertKind; label: string }> = [
  { kind: "url", label: "URL contains…" },
  { kind: "urlEndsWith", label: "URL ends with…" },
  { kind: "urlIs", label: "URL is…" },
];

/** The native-menu bridge, reached the same way `recording-view.tsx` reaches
 *  it. Typed locally rather than imported so this window's bundle does not pull
 *  in the whole recording view. */
interface NativeMenu {
  popup: (options: {
    items: { label?: string; type?: "separator"; commandId?: number }[];
    x?: number;
    y?: number;
    coordinateSpace?: "screen" | "view";
  }) => Promise<{ commandId?: number }>;
}
function nativeMenu(): NativeMenu {
  return (window as unknown as { glazeAPI: { Menu: NativeMenu } }).glazeAPI.Menu;
}

export function UrlBar({ url, loading }: UrlBarProps): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  const { origin, rest } = splitForDisplay(url);

  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = React.useCallback(() => {
    if (!url) return;
    copyText(url);
    setCopied(true);
  }, [url]);

  // The assert menu is a NATIVE menu, for the same reason the page's
  // right-click menu is: this window's other occupant is an untrusted page, and
  // a React popover drawn in the strip would be clipped to the strip's height.
  // Menu.popup has no such ceiling.
  const openAssertMenu = React.useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const res = await nativeMenu().popup({
      x: Math.round(rect.left),
      y: Math.round(rect.bottom),
      coordinateSpace: "view",
      items: URL_ASSERTS.map((entry, i) => ({ label: entry.label, commandId: i })),
    });
    if (typeof res.commandId !== "number") return;
    const picked = URL_ASSERTS[res.commandId];
    if (picked) await api.recorder.assertUrl(picked.kind);
  }, []);

  return (
    <div className="border-separator bg-panel flex h-full w-full items-center gap-2 border-b px-2">
      <Link2
        className={
          loading
            ? "size-3.5 shrink-0 animate-pulse text-tertiary"
            : "size-3.5 shrink-0 text-tertiary"
        }
        aria-hidden="true"
      />

      {/* `select-text` explicitly: the strip sits in a window the user drags by
          its frame, and the app's base layer turns selection off so a drag
          never smears a highlight across the UI. Here selection is the point. */}
      <div
        className="min-w-0 flex-1 select-text truncate font-mono text-xs"
        title={url}
        data-testid="training-url"
      >
        {url ? (
          <>
            <span className="text-tertiary">{origin}</span>
            <span className="text-primary">{rest}</span>
          </>
        ) : (
          <Text variant="small" color="tertiary">
            Loading…
          </Text>
        )}
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="small"
            onClick={copy}
            disabled={!url}
            aria-label="Copy URL"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied" : "Copy URL"}</TooltipContent>
      </Tooltip>

      <Button variant="ghost" size="small" onClick={openAssertMenu} disabled={!url}>
        Assert URL
      </Button>
    </div>
  );
}
