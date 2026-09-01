// What ORIGIN a URL is on, and whether a text sits on one — the two primitives
// every same-site question in this app reduces to.
//
// Moved here from main/services/origin-variable.ts (which now imports them)
// for the standard shared/ reason: a second process needs the same answer.
// Cross-test propagation groups heal donors and their targets by origin, and
// the MCP/CLI runner has to derive the same grouping when it seeds a heal map
// — plain .mjs with no build step, so the rule cannot live in compiled
// TypeScript. Two spellings of "same site" would disagree exactly once, on the
// host where it matters.
//
// Pure: no fs, no IPC, no process.

/**
 * The origin of a URL, or null.
 *
 * `URL.origin` rather than a regex: it normalises case and the default port,
 * so `https://Shop.Example.com:443/` and `https://shop.example.com/` are one
 * origin rather than two entries the user has to pick between.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function originOf(text) {
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Whether `text` is a URL sitting on `origin`.
 *
 * The text must START with the origin and continue with nothing, `/`, `?` or
 * `#`. That rules out two things a bare startsWith would wrongly accept: a
 * different host that shares a prefix (`https://shop.example.commerce.test`),
 * and a sentence that merely mentions the address in the middle.
 *
 * @param {string} text
 * @param {string} origin
 * @returns {boolean}
 */
export function isOnOrigin(text, origin) {
  if (!text.startsWith(origin)) return false;
  const rest = text.slice(origin.length);
  return rest === "" || rest.startsWith("/") || rest.startsWith("?") || rest.startsWith("#");
}
