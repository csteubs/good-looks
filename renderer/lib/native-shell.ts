// The renderer's one accessor for `glazeAPI.shell`.
//
// This existed twice before, as a locally-declared `interface NativeShell` in
// `library-sidebar.tsx` and a differently-shaped inline type in
// `stats-view.tsx` — each describing the subset its own file happened to call.
// That is fine until a third caller wants a method neither declared, at which
// point the type is whatever the nearest file guessed. `openExternal` is that
// third caller, and it is the one method where being wrong about the contract
// matters: the main side refuses a URL it doesn't like, silently, so a caller
// working from a wrong type would see nothing happen and have nowhere to look.
//
// Not part of `api.ts`: that module is this app's own IPC surface, and these
// are the host capabilities the preload exposes underneath it.

export interface NativeShell {
  /** Reveals a path in Finder. */
  showItemInFolder: (fullPath: string) => void;
  /** Opens a URL in the user's real browser. https on github.com only — the
   *  main process refuses anything else and logs why. */
  openExternal: (url: string) => void;
}

export function nativeShell(): NativeShell {
  return (window as unknown as { glazeAPI: { shell: NativeShell } }).glazeAPI.shell;
}
