// Importing a folder of Playwright tests — the whole action, in one place.
//
// It was inline in `library-sidebar.tsx`, which is why the folder importer was
// reachable from the library rail's `+` menu and NOWHERE else: not from Home,
// not from the ⌘K palette, and half the app's creation methods were behind one
// native menu most users never open. Moving the body here is what lets three
// entry points offer the same thing without three copies of the toast rules.
//
// It takes its two collaborators as arguments rather than calling hooks,
// because it is not a hook: the callers are already inside components that have
// a query client and a navigate function, and a hook here would make this
// unusable from an event handler in a component that has neither.

import { toast } from "@ui";

import { api } from "./api";
import { importWarnings } from "./import-warnings";

export interface ImportDeps {
  invalidateTests: () => void;
  goToTest: (id: string) => void;
}

/** Open the native folder picker and import whatever it finds.
 *
 *  Resolves either way — a failure surfaces as a toast, because every caller is
 *  an event handler and an unhandled rejection is the alternative. */
export async function importFromFiles({ invalidateTests, goToTest }: ImportDeps): Promise<void> {
  try {
    const res = await api.tests.importFiles();
    // Zero is the cancelled picker, not an empty folder — a folder with no
    // tests throws. Saying "Imported 0 tests" to somebody who pressed Cancel is
    // reporting on a thing they did not do.
    if (res.imported === 0) return;
    invalidateTests();
    toast.success(res.imported === 1 ? "Imported 1 test." : `Imported ${res.imported} tests.`);
    for (const w of importWarnings(res)) toast.warning(w);
    if (res.ids[0]) goToTest(res.ids[0]);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Failed to import tests.");
  }
}
