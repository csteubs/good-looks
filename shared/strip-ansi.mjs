// Stripping terminal escape sequences from run output.
//
// Pure (see the admission rule in run-pacing.mjs). Shared so the MCP server
// applies it too: it writes raw child stdout/stderr straight to the `.log` file
// that `get_run_log` later serves back to an agent, which is the worst of the
// three consumers this was written for — the bytes are meaningless outside a
// terminal, and there they are spent context.
//
// Playwright's `line` reporter redraws its progress line with cursor-up +
// erase-line, and colours failures. Left in, those bytes reach three places
// they have no business being: the Output panel renders them as visible
// mojibake (`⌧[1A⌧[2K`), the log file keeps them forever, and they are sent
// verbatim to the model in the Debug-with-AI prompt.

// Built from a char code rather than a regex literal: ESC is a control
// character, and `no-control-regex` rejects it inline. Disabling that rule
// here would also disable it for anything added to this file later.
const ANSI_ESCAPE = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g");

/** Remove every CSI escape sequence, leaving the visible text untouched. */
export function stripAnsi(text) {
  return text.replace(ANSI_ESCAPE, "");
}
