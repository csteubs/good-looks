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
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 overflow-hidden px-8 py-10 text-center">
          {animationEnabled ? <BlackHoleLoader size={440} dark={isDarkMode} /> : null}
          <div className="flex max-w-sm flex-col gap-2">
            <h1 className="text-heading1" style={{ fontSize: "54px" }}>GOOD LOOKS!</h1>
            <p className="text-regular" style={{ padding: "60px 0px" }}>
              Click the + in the sidebar, enter a website, and interact with it. Every click, input, and navigation
              becomes a test step — then generate and run a Playwright script.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
