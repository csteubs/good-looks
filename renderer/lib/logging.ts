// Renderer logging bootstrap.
//
// Under Glaze this piped console output to the native host's log. Under
// Electron the renderer's console is already first-class (View → Toggle
// Developer Tools), so there is nothing to forward — the entry points keep
// calling initLogging() and it deliberately does nothing.

export function initLogging(): void {
  /* console is native under Electron */
}
