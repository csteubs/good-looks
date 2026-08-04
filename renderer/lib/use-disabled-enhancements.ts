import * as React from "react";

import { api } from "./api";

/** Loads the user's disabled aesthetic-enhancement feature IDs. Returns a
 *  `Set` for O(1) membership checks. Empty = all features enabled. */
export function useDisabledEnhancements(): Set<string> {
  const [ids, setIds] = React.useState<string[]>([]);
  React.useEffect(() => {
    api.recorder
      .getSettings()
      .then((s) => setIds(s.disabledAestheticEnhancements ?? []))
      .catch(() => {
        /* defaults to all enabled */
      });
  }, []);
  return new Set(ids);
}
