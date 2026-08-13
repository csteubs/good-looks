// The renderer talks to no third party the user has not agreed to.
//
// WHY THIS EXISTS, and it is not hypothetical. `library-sidebar.tsx` fetched
// `https://www.google.com/s2/favicons?domain=<host>` for EVERY test in the
// library, on every render of the sidebar. Opening the app sent Google the
// hostname of every site under test. A QA tool's library routinely names
// unreleased staging hosts and internal domains, and this app's stated egress
// posture is ONE opt-in summary-only webhook (DECISIONS 2026-08-04).
//
// It shipped, and it was invisible: no setting, no disclosure, no mention in
// any doc, and no way to see it except by reading that one function. It was
// found while surveying the file for an unrelated redesign change. That is the
// entire argument for this check — nothing else in the toolchain looks at where
// a URL points, and an `<img src>` to a third party is indistinguishable from a
// local one at every layer above the network.
//
// WHAT IS ALLOWED. An absolute URL is fine when it is a place the user typed, a
// place the user configured, or a string being shown to them as text. What is
// not fine is a host this app decided to contact on its own. The allowlist
// below is therefore of SPECIFIC STRINGS, not of hosts — every entry names why
// it is there, and a new one is a decision someone has to write down.
//
// Run with: npm run check:renderer-egress

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * Absolute URLs the renderer may legitimately contain.
 *
 * Each entry is a substring plus the reason it is allowed. Adding one is
 * deliberately a little annoying: the point is that "this app contacts a new
 * host" becomes a sentence someone writes down rather than a line someone adds.
 */
const ALLOWED: Array<{ needle: string; why: string }> = [
  {
    needle: "https://api.anthropic.com",
    why: "the Claude provider's default base URL — a configured provider the user chooses and can change",
  },
  {
    needle: "https://hooks.slack.com/services/",
    why: "placeholder text in the alerts pane; shown to the user, never fetched",
  },
  {
    needle: "https://github.com/user/repo.git",
    why: "placeholder text in the import dialog; shown to the user, never fetched",
  },
  {
    needle: "https://icons.duckduckgo.com/ip3/",
    why: "SiteIcon's favicon source, which is OPT-IN and off by default (REDESIGN §3.5) — the component sends nothing unless a setting turns it on",
  },
  {
    needle: "(https://)",
    why: "prose in the alerts pane explaining that a webhook URL must be https",
  },
  {
    needle: "http://www.w3.org/2000/svg",
    why: "the SVG namespace — an XML identifier, never dereferenced",
  },
];

// ── No unexplained absolute URL in the renderer ───────────────────────

{
  const offenders: string[] = [];
  let scanned = 0;

  for (const file of walk(join(root, "renderer"))) {
    // Tests and the preview's fixtures are not shipped and are allowed to name
    // whatever they are asserting about.
    if (/\.test\.tsx?$/.test(file) || file.includes("/dev/") || file.includes("/__tests__/")) {
      continue;
    }
    // COMMENTS FIRST, and this is not a nicety: the reasoning around an egress
    // decision names the URL constantly — the comment above `Favicon` in the
    // sidebar quotes the exact string this check was written to ban. A check
    // that flags its own explanation gets switched off within a week.
    //
    // Block comments are stripped from the whole file before splitting, because
    // a URL on a continuation line of a `/* */` block has no `//` on it to
    // recognise. Line comments are stripped only where `//` is not preceded by
    // a colon, or the pattern would eat the scheme of every URL it is looking
    // for.
    const src = readFileSync(file, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
    src.split("\n").forEach((rawLine, i) => {
      const line = rawLine.replace(/(^|[^:])\/\/.*$/, "$1");
      const m = /https?:\/\/[^\s"'`)]+/.exec(line);
      if (!m) return;
      scanned++;
      // This machine. Not egress.
      if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/.test(m[0])) return;
      // `example.com` and friends are IANA-reserved (RFC 2606 / RFC 6761) and
      // exist precisely to be written into documentation and placeholder text.
      // They resolve nowhere anyone owns, so they cannot be an egress path — and
      // exempting the category rather than each individual placeholder string
      // keeps the allowlist below meaningful.
      if (/^https?:\/\/([a-z0-9-]+\.)*(example\.(com|net|org)|example|invalid|test|localhost)(\/|$|[:?#])/i.test(m[0])) {
        return;
      }
      if (ALLOWED.some((a) => line.includes(a.needle))) return;
      offenders.push(`${file.slice(root.length + 1)}:${i + 1} — ${m[0].slice(0, 72)}`);
    });
  }

  assert(
    scanned > 0,
    `found ${scanned} absolute URLs in the renderer to judge (zero means the pattern rotted)`,
  );
  assert(
    offenders.length === 0,
    offenders.length === 0
      ? "every absolute URL in the renderer is one the user typed, configured, or is being shown"
      : `an outbound host this app decided to contact on its own:\n     ${offenders.join(
          "\n     ",
        )}\n\n     If this is deliberate, add it to ALLOWED in this file WITH THE REASON,\n     and make sure the user can see and refuse it.`,
  );
}

// ── The documents the renderer bundles are held to the same rule ──────

{
  // `docs/MCP-GUIDE.md` is imported with `?raw` and inlined into the renderer
  // bundle, so prose in it ships exactly like source does. The scan above only
  // walks `.ts`/`.tsx`, which means moving a sentence out of a pane and into a
  // document would have moved it out of this check's sight — and the whole
  // argument for the check is that nothing else in the toolchain looks at where
  // a URL points.
  //
  // Displaying a URL is not fetching one: these pages are rendered as text, and
  // only https on github.com is clickable at all (main/shell/external-url.ts).
  // The point is the SECOND LOOK, which is the same reason the allowlist above
  // is of specific strings rather than of hosts.
  const offenders: string[] = [];
  for (const rel of ["docs/MCP-GUIDE.md"]) {
    readFileSync(join(root, rel), "utf-8")
      .split("\n")
      .forEach((line, i) => {
        const m = /https?:\/\/[^\s"'`)\]]+/.exec(line);
        if (!m) return;
        if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(m[0])) return;
        if (ALLOWED.some((a) => line.includes(a.needle))) return;
        offenders.push(`${rel}:${i + 1} — ${m[0].slice(0, 72)}`);
      });
  }
  assert(
    offenders.length === 0,
    offenders.length === 0
      ? "every absolute URL in the shipped documentation is one the user typed, configured, or is being shown"
      : `a URL in shipped documentation that nobody has justified:\n     ${offenders.join("\n     ")}`,
  );
}

// ── The sidebar specifically does not fetch per-test icons ────────────

{
  // The regression that actually happened, pinned by name. The general rule
  // above would catch it too, but a check that names the bug it was written for
  // is the one someone understands when it fires.
  const sidebar = readFileSync(join(root, "renderer/main/library-sidebar.tsx"), "utf-8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  assert(
    !/google\.com\/s2\/favicons/.test(sidebar),
    "the library sidebar does not send every test's hostname to a favicon service",
  );
}

// ── SiteIcon's own opt-in really is opt-in ────────────────────────────

{
  // The allowlist above tolerates the DuckDuckGo URL only because reaching it
  // requires a caller to pass `favicon`. If that ever defaults on, the
  // allowlist entry silently becomes a licence for the same bug.
  const siteIcon = readFileSync(join(root, "renderer/theme/primitives/site-icon.tsx"), "utf-8");
  assert(
    /favicon === true/.test(siteIcon),
    "SiteIcon fetches only on an explicit `favicon` opt-in, never on a truthy default",
  );

  // B4 landed the setting this was waiting for, so a call site passing
  // `favicon` is no longer forbidden — it is forbidden to pass it TURNED ON. A
  // bare `favicon` or `favicon={true}` is the exact regression the whole check
  // exists for, dressed as an opt-in; anything else is an expression, and the
  // assertions below are what pin that expression to a real, defaulted-off
  // setting.
  const hardcoded: string[] = [];
  for (const file of walk(join(root, "renderer"))) {
    if (/\.test\.tsx?$/.test(file) || file.includes("/dev/")) continue;
    const src = readFileSync(file, "utf-8");
    for (const m of src.matchAll(/<SiteIcon\b[^>]*?>/gs)) {
      if (/\bfavicon(\s*=\s*\{\s*true\s*\})?(\s|\/|>)/.test(m[0])) {
        hardcoded.push(`${file.slice(root.length + 1)}: ${m[0].slice(0, 60)}`);
      }
    }
  }
  assert(
    hardcoded.length === 0,
    hardcoded.length === 0
      ? "no shipped call site hardcodes SiteIcon's favicon fetch on"
      : `these turn the third-party favicon fetch on unconditionally — it has to follow the setting:\n     ${hardcoded.join("\n     ")}`,
  );

  // The setting itself, on both sides of the IPC boundary. Either default
  // flipping to `true` turns the fetch on for everyone who never opened
  // Settings, which is precisely the state the original bug was in.
  const store = readFileSync(join(root, "main/services/recorder-settings-store.ts"), "utf-8");
  assert(
    /siteIconsFromWeb:\s*false,/.test(store),
    "the backend's default for siteIconsFromWeb is off",
  );
  const schema = readFileSync(join(root, "renderer/lib/settings-schema.ts"), "utf-8");
  assert(
    /siteIconsFromWeb:\s*false,/.test(schema),
    "the renderer's default for siteIconsFromWeb is off, so 'reset section' cannot turn it on",
  );

  // And the disclosure. An opt-in whose copy does not say who is being told
  // what is not an opt-in, it is a switch — REDESIGN §3.5 asks for the host and
  // the payload by name, so both are asserted rather than the row's existence.
  const appearance = readFileSync(
    join(root, "renderer/settings/panes/appearance-pane.tsx"),
    "utf-8",
  );
  assert(
    /id="site-icons-from-web"/.test(appearance),
    "the site-icon opt-in has a row the user can find",
  );
  assert(
    /risk=/.test(appearance) && /icons\.duckduckgo\.com/.test(appearance),
    "that row names the third party in its always-visible risk copy, not behind a disclosure",
  );
  assert(
    /hostname/.test(appearance),
    "that row says what is sent, not only where it goes",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll renderer-egress checks passed.");
