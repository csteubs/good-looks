// The trainer agent's bounded view of the live page: an inventory of the
// elements a step could point at, capped hard in count and text length —
// NEVER raw HTML, never an input's value.
//
// Two rules, both security-shaped. Element VALUES are not collected at all:
// a live form holds whatever the user has typed, passwords included, and a
// summary that reads `.value` ships it to whichever model the chat slot
// names. And everything that comes back is page JSON, so it crosses the same
// kind of boundary the capture channel does — `normalizePageSummary` REBUILDS
// each entry from named keys (never spreads), enforces the caps a second
// time, and drops anything that is not the shape it claims to be. The script
// runs where the heal probe runs (`executeJavaScript` against the training
// page) and follows its conventions: self-contained source text, a plain
// JSON-able return, no page-visible globals.

export const MAX_SUMMARY_ELEMENTS = 40;
export const MAX_SUMMARY_TEXT = 80;
const MAX_ATTR = 120;

/** One element the agent may target. Structural identity only — the fields
 *  the recorder's own locator kinds are built from. */
export interface PageElementSummary {
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  id?: string;
  testid?: string;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
}

export interface PageSummary {
  url: string;
  title: string;
  /** Visible interactables (and headings, for assertions), DOM order,
   *  capped at MAX_SUMMARY_ELEMENTS. */
  elements: PageElementSummary[];
  /** How many qualified before the cap — so the prompt can say "40 of 212"
   *  rather than implying the list is the page. */
  total: number;
}

/** The injected probe. A string for the same reason the heal probe is one:
 *  it runs in the training page's context, not in this process. */
export function buildPageSummaryScript(): string {
  return `(() => {
  const MAX_ELEMENTS = ${MAX_SUMMARY_ELEMENTS};
  const MAX_TEXT = ${MAX_SUMMARY_TEXT};
  const clip = (s, n) => {
    const t = (s || "").replace(/\\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) : t;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  const SELECTOR = [
    "button", "a[href]", "input", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=tab]", "[role=checkbox]",
    "[role=radio]", "[role=menuitem]", "[role=combobox]", "[role=switch]",
    "[data-testid]", "h1", "h2", "h3",
  ].join(",");
  const all = Array.from(document.querySelectorAll(SELECTOR)).filter(visible);
  const out = [];
  for (const el of all) {
    if (out.length >= MAX_ELEMENTS) break;
    const entry = { tag: el.tagName.toLowerCase() };
    const role = el.getAttribute("role");
    if (role) entry.role = clip(role, 40);
    const name = el.getAttribute("aria-label");
    if (name) entry.name = clip(name, MAX_TEXT);
    // Text content, never value: a field's live value can be a secret.
    const text = clip(el.tagName === "SELECT" ? "" : el.textContent || "", MAX_TEXT);
    if (text) entry.text = text;
    if (el.id) entry.id = clip(el.id, ${MAX_ATTR});
    const testid = el.getAttribute("data-testid");
    if (testid) entry.testid = clip(testid, ${MAX_ATTR});
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) entry.placeholder = clip(placeholder, MAX_TEXT);
    const type = el.getAttribute("type");
    if (type) entry.type = clip(type, 40);
    if (el.disabled === true || el.getAttribute("aria-disabled") === "true") entry.disabled = true;
    out.push(entry);
  }
  return {
    url: String(location.href).slice(0, 500),
    title: clip(document.title, 200),
    elements: out,
    total: all.length,
  };
})()`;
}

const str = (v: unknown, cap: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, cap) : undefined;
};

/** The ingest half — page JSON in, rebuilt model out, or null. */
export function normalizePageSummary(input: unknown): PageSummary | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const url = str(o.url, 500) ?? "";
  const title = str(o.title, 200) ?? "";
  const rawElements = Array.isArray(o.elements) ? o.elements : [];
  const elements: PageElementSummary[] = [];
  for (const raw of rawElements) {
    if (elements.length >= MAX_SUMMARY_ELEMENTS) break;
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const tag = str(e.tag, 40);
    if (!tag) continue;
    // REBUILT from named keys — an unknown key from the page dies here.
    const entry: PageElementSummary = { tag };
    const role = str(e.role, 40);
    if (role) entry.role = role;
    const name = str(e.name, MAX_SUMMARY_TEXT);
    if (name) entry.name = name;
    const text = str(e.text, MAX_SUMMARY_TEXT);
    if (text) entry.text = text;
    const id = str(e.id, MAX_ATTR);
    if (id) entry.id = id;
    const testid = str(e.testid, MAX_ATTR);
    if (testid) entry.testid = testid;
    const placeholder = str(e.placeholder, MAX_SUMMARY_TEXT);
    if (placeholder) entry.placeholder = placeholder;
    const type = str(e.type, 40);
    if (type) entry.type = type;
    if (e.disabled === true) entry.disabled = true;
    elements.push(entry);
  }
  const total = typeof o.total === "number" && Number.isFinite(o.total)
    ? Math.max(elements.length, Math.min(Math.round(o.total), 100_000))
    : elements.length;
  return { url, title, elements, total };
}
