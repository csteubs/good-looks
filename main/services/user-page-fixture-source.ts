// The user stylesheet and init script, as a run fixture (the
// dismiss-fixture-source.ts idiom): a raw JS string written beside the specs,
// imported by the capture fixture, installed on every page of a run.
//
// Settings → Recording → "Page stylesheet" / "Page init script" are applied
// in TWO places by design, like overlay rules: in the trainer (on every
// document's dom-ready, from recorder-service.ts) and in every run (here).
// A widget hidden while recording but present in the run is a test that
// passes in one place and fails in the other.
//
// The run half is the stronger one: `context.addInitScript` runs BEFORE the
// page's own scripts, which the trainer's dom-ready injection cannot; the
// stylesheet goes in on `domcontentloaded` of every document, early enough
// to hide a banner before it paints in practice, and again on `load` for a
// page that replaces its head.
//
// Both travel as base64 in the environment — one value each, never split —
// so a stylesheet with newlines or quotes survives the shell and a crash
// dump carries two opaque strings rather than the text.

export const USER_PAGE_FIXTURE_FILE = "glaze-user-page.mjs";
export const USER_CSS_ENV = "GLAZE_USER_CSS_B64";
export const USER_INIT_ENV = "GLAZE_USER_INIT_B64";

/** The environment a run gets for the two settings; empty when both are. */
export function userPageEnv(settings: { userStylesheet?: string; userInitScript?: string }): Record<string, string> {
  const out: Record<string, string> = {};
  const css = (settings.userStylesheet ?? "").trim();
  const js = (settings.userInitScript ?? "").trim();
  if (css) out[USER_CSS_ENV] = Buffer.from(css, "utf-8").toString("base64");
  if (js) out[USER_INIT_ENV] = Buffer.from(js, "utf-8").toString("base64");
  return out;
}

export const userPageFixtureSource = `const CSS = process.env.${USER_CSS_ENV} ? Buffer.from(process.env.${USER_CSS_ENV}, "base64").toString("utf-8") : "";
const INIT = process.env.${USER_INIT_ENV} ? Buffer.from(process.env.${USER_INIT_ENV}, "base64").toString("utf-8") : "";

function note(msg) {
  try {
    process.stderr.write("[glaze-user-page] " + msg + "\\n");
  } catch (e) {
    /* best effort */
  }
}

/** Install the user's stylesheet and init script on a page's context.
 *  Answers what was installed, for the run log. */
export async function installUserPage(page) {
  const installed = [];
  if (INIT) {
    // The script runs in every document before the page's own code, as
    // Playwright's addInitScript does. It is the user's code, in the page —
    // never in Node.
    await page.context().addInitScript(INIT);
    installed.push("init script (" + INIT.length + " chars)");
  }
  if (CSS) {
    const apply = async () => {
      try {
        await page.addStyleTag({ content: CSS });
      } catch (e) {
        // A document that navigated away mid-insert; the next event re-applies.
      }
    };
    page.on("domcontentloaded", apply);
    page.on("load", apply);
    installed.push("stylesheet (" + CSS.length + " chars)");
  }
  if (installed.length) note("installed: " + installed.join(", "));
  return installed;
}
`;
