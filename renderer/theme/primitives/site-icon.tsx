// SiteIcon — custom image → favicon → generated monogram. Never nothing.
//
// THE FAVICON FETCH IS AN EGRESS PATH, AND THAT IS WHY IT IS OFF BY DEFAULT.
//
// The mockup calls `https://icons.duckduckgo.com/ip3/<host>.ico` for every
// non-reserved host in the library. That sends the hostname of every site under
// test to a third party, on every render of the sidebar — and a QA tool's test
// list routinely names unreleased staging hosts and internal domains. This
// app's stated egress posture is ONE opt-in summary-only webhook (DECISIONS
// 2026-08-04), so a silent per-row lookup is not a detail, it is a new outbound
// channel that nobody agreed to.
//
// So the monogram is the DEFAULT, not the fallback-of-last-resort. It is
// already deterministic per host and already the answer for reserved names — a
// complete design on its own, not a degraded one. `favicon` is opt-in, and the
// setting that turns it on has to say what it sends and where (REDESIGN §3.5).
//
// THE MONOGRAM PALETTE IS DELIBERATELY NOT THE STATUS PALETTE. Colour means
// outcome; a site tile in phosphor green beside a row that failed would be the
// only green thing on screen and would read as a pass. These six are muted and
// low-saturation on purpose, and there is a test that pins them apart from
// TONE.
//
// Built as its own component because FOLDERS WILL NEED EXACTLY THIS NEXT
// (REDESIGN §7.2) — a group is a monogram of its own name rather than of a
// host, and everything else about the tile is the same.

import * as React from "react";

/** Muted, and none of them a status hue. See the header. */
const MONOGRAM_HUES = [
  "#5b6d8c", // slate
  "#7a6288", // mauve
  "#4f7d76", // teal-grey
  "#8a7350", // ochre
  "#8a5f66", // rose-grey
  "#5f7a55", // sage
] as const;

/** Reserved names get a monogram unconditionally — there is no third party that
 *  knows what `localhost` looks like, and asking one would leak the fact that
 *  something is being tested locally for no return. */
function isReserved(host: string): boolean {
  if (host === "" || host === "localhost" || host.endsWith(".local")) return true;
  if (host === "::1" || host.startsWith("[")) return true;
  // Any bare IPv4. A private range is obviously reserved, and a public one is
  // an address the user typed rather than a site with an icon.
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** djb2. Deterministic and stable across sessions, which is the only property
 *  that matters: the same host must get the same tile every time, or the
 *  sidebar reshuffles its colours on every launch and stops being learnable. */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/** The letters. Two from the site's own name where there is one to take them
 *  from — `shop.example.com` is "SH", not "SE" — because the subdomain is what
 *  distinguishes rows in a list where half the hosts share a domain. */
export function monogramLetters(host: string): string {
  const cleaned = host.replace(/^www\./, "").trim();
  if (cleaned === "") return "?";
  const first = cleaned.split(".")[0] ?? cleaned;
  const alnum = first.replace(/[^a-z0-9]/gi, "");
  if (alnum === "") return cleaned.slice(0, 1).toUpperCase();
  return alnum.slice(0, 2).toUpperCase();
}

export function monogramHue(host: string): string {
  return MONOGRAM_HUES[hash(host) % MONOGRAM_HUES.length];
}

export interface SiteIconProps {
  /** A hostname, or any name at all — a group's name works, which is the point
   *  (REDESIGN §7.2). */
  host: string;
  /** A user-supplied image. Wins over everything; no network involved. */
  src?: string;
  /** Fetch a third-party favicon. OFF BY DEFAULT — it sends this hostname to
   *  someone else. Ignored for reserved names. */
  favicon?: boolean;
  size?: number;
}

export function SiteIcon({ host, src, favicon, size = 16 }: SiteIconProps): React.ReactElement {
  // A remote icon that 404s or is blocked must not leave a hole, so the failure
  // is state rather than an empty <img>. Keyed by host so switching rows does
  // not inherit the previous host's failure.
  const [remoteFailed, setRemoteFailed] = React.useState(false);
  React.useEffect(() => setRemoteFailed(false), [host, src, favicon]);

  const style: React.CSSProperties = { width: size, height: size };

  if (src !== undefined && !remoteFailed) {
    return (
      <img
        className="gl-site-icon"
        style={style}
        src={src}
        alt=""
        data-gl="site-icon"
        data-kind="custom"
        onError={() => setRemoteFailed(true)}
      />
    );
  }

  if (favicon === true && !isReserved(host) && !remoteFailed) {
    return (
      <img
        className="gl-site-icon"
        style={style}
        src={`https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`}
        alt=""
        data-gl="site-icon"
        data-kind="favicon"
        onError={() => setRemoteFailed(true)}
      />
    );
  }

  return (
    <span
      className="gl-site-icon gl-site-monogram"
      style={{
        ...style,
        background: `${monogramHue(host)}2e`,
        color: monogramHue(host),
        fontSize: Math.round(size * 0.44),
      }}
      data-gl="site-icon"
      data-kind="monogram"
      // Decorative: the row already names the host in text beside it, and an
      // icon that reads its own letters aloud says everything twice.
      aria-hidden
    >
      {monogramLetters(host)}
    </span>
  );
}
