import { Toolbar, ToolbarContent, ToolbarTitle } from "@ui";
import { useTheme } from "@ui";

import { BlackHoleLoader } from "./black-hole-loader";
import { useDisabledEnhancements } from "../lib/use-disabled-enhancements";

export function HomeView() {
  const isDarkMode = useTheme();
  const disabledEnhancements = useDisabledEnhancements();
  const animationEnabled = !disabledEnhancements.has("homeBlackHole");

  return (
    <div className="relative flex h-full flex-col">
      <Toolbar>
        <ToolbarContent>
          <ToolbarTitle> </ToolbarTitle>
        </ToolbarContent>
      </Toolbar>
      <div className="relative flex-1">
        {/* Scrolls rather than clips. This was `overflow-hidden`, so at a 720px
            window — an ordinary size — the last line of the copy below was cut
            off with no way to reach it: the pane could not scroll and the page
            behind it was already exactly viewport height.

            `min-h-full` on the inner column is what lets `justify-center` stay
            honest. It is a FLOOR, not a cap: when the content is short the
            column is exactly viewport height and centres; when the content is
            taller the column grows past it, `justify-center` has no free space
            left to distribute, and the content starts at the top and scrolls
            instead of being centred half-off-screen. */}
        <div className="absolute inset-0 overflow-y-auto">
          <div className="flex min-h-full flex-col items-center justify-center gap-6 px-8 py-10 text-center">
            {animationEnabled ? <BlackHoleLoader size={440} dark={isDarkMode} /> : null}
            <div className="flex max-w-sm flex-col gap-2">
              <h1 className="text-heading1" style={{ fontSize: "54px" }}>GOOD LOOKS!</h1>
              {/* The 120px of inline vertical padding that used to be here was
                  the single biggest contributor to the overflow, and it
                  double-spaced against the `gap-6` above. */}
              <p className="text-regular">
                Click the + in the sidebar, enter a website, and interact with it. Every click, input, and navigation
                becomes a test step — then generate and run a Playwright script.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
