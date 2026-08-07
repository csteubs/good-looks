// Keeps the document's `.dark` class in sync with the effective theme and
// returns whether dark is active.
//
// Two inputs: the main process (nativeTheme, which honours the user's Theme
// setting including an explicit light/dark override) and the OS media query as
// a fallback before the first IPC round-trip resolves. The entry HTML already
// sets the class from the media query so there is no first-paint flash; this
// hook takes over once the real answer arrives, and re-runs on the
// `nativeTheme:updated` push.

import * as React from "react";

interface ThemeBridge {
  nativeTheme?: {
    getShouldUseDarkColors?: () => Promise<boolean>;
  };
  glaze?: {
    ipc?: { on?: (channel: string, cb: (...args: unknown[]) => void) => () => void };
  };
}

function bridge(): ThemeBridge | undefined {
  return (window as unknown as { glazeAPI?: ThemeBridge }).glazeAPI;
}

function apply(isDark: boolean): void {
  document.documentElement.classList.toggle("dark", isDark);
}

export function useTheme(): boolean {
  const [isDark, setIsDark] = React.useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches,
  );

  React.useEffect(() => {
    let cancelled = false;

    const sync = () => {
      const get = bridge()?.nativeTheme?.getShouldUseDarkColors;
      if (!get) return;
      void get()
        .then((dark) => {
          if (cancelled) return;
          setIsDark(dark);
          apply(dark);
        })
        .catch(() => {});
    };

    sync();

    // The main process broadcasts on every theme change (OS flip or an explicit
    // setThemeSource from Settings), so both paths land here.
    const off = bridge()?.glaze?.ipc?.on?.("nativeTheme:updated", () => sync());

    // Fallback for a window that somehow has no bridge yet.
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onMq = (e: MediaQueryListEvent) => {
      if (!bridge()?.nativeTheme) {
        setIsDark(e.matches);
        apply(e.matches);
      }
    };
    mq?.addEventListener?.("change", onMq);

    return () => {
      cancelled = true;
      off?.();
      mq?.removeEventListener?.("change", onMq);
    };
  }, []);

  React.useEffect(() => {
    apply(isDark);
  }, [isDark]);

  return isDark;
}
