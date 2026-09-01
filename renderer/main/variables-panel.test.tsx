// Component tests for the Variables + Datasets panel.
//
// The property worth testing here is the one a screenshot can't show: a
// secret's VALUE must never be something this component holds, renders, or can
// ask for. There is no api.tests.getSecret to call — the panel knows only
// whether a value exists — and these tests pin that asymmetry, because the
// obvious "improvement" (show the current value so the user can check it)
// would quietly undo the whole point of the encrypted store.
//
// The rest covers the two mistakes the panel exists to prevent: deleting a
// variable that steps still reference, and building dataset rows for a secret.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { clearToastCalls, toastTexts } from "../__tests__/sonner-stub";
import type { SecretStatus, TestRecord } from "../lib/recorder-types";
import { VariablesPanel } from "./variables-panel";

const setVariables = vi.fn(async (_id: string, _v: unknown) => ({}) as TestRecord);
let originsData: { origin: string; count: number }[] = [];
const parameteriseOrigin = vi.fn(async (_id: string, origin: string) => ({
  test: { id: "t1", variables: [{ name: "SITE_URL", kind: "plain" as const, value: origin }] } as TestRecord,
  rewritten: 3,
  reusedVariable: false,
  name: "SITE_URL",
}));
const setDatasets = vi.fn(async (_id: string, _d: unknown) => ({}) as TestRecord);
const setSecret = vi.fn(async (_id: string, name: string, _value: string) => ({
  name,
  hasValue: true,
}));
const clearSecret = vi.fn(async (_id: string, name: string) => ({ name, hasValue: false }));
const batchRun = vi.fn(async (_ids: string[], _opts: unknown) => ({
  batchId: "b1",
  alreadyRunning: false,
}));
const setFlow = vi.fn(async (_id: string, _isFlow: boolean, _params: string[]) => ({}) as TestRecord);
interface ImportCsvResult {
  ok: boolean;
  canceled?: boolean;
  imported: number;
  problem?: string;
  createdVariables: string[];
  skippedColumns: { name: string; reason: string }[];
  raggedRows: number;
  truncated: boolean;
}
const importDatasetCsv = vi.fn(
  async (_id: string): Promise<ImportCsvResult> => ({
    ok: false,
    canceled: true,
    imported: 0,
    createdVariables: [],
    skippedColumns: [],
    raggedRows: 0,
    truncated: false,
  }),
);
let secretStatus: SecretStatus[] = [];
const setSession = vi.fn(async (_id: string, _p: unknown) => ({}) as TestRecord);
const setBasicAuth = vi.fn(async (_id: string, _ba: unknown) => ({}) as TestRecord);
let sessionState: { savedAt: number; fresh: boolean } | null = null;
let allTests: TestRecord[] = [];

vi.mock("../lib/api", () => ({
  api: {
    tests: {
      setVariables: (id: string, v: unknown) => setVariables(id, v),
      originsIn: async () => originsData,
      parameteriseOrigin: (id: string, origin: string) => parameteriseOrigin(id, origin),
      setDatasets: (id: string, d: unknown) => setDatasets(id, d),
      setSecret: (id: string, name: string, value: string) => setSecret(id, name, value),
      clearSecret: (id: string, name: string) => clearSecret(id, name),
      secretStatus: async () => secretStatus,
      setFlow: (id: string, isFlow: boolean, params: string[]) => setFlow(id, isFlow, params),
      setSession: (id: string, patch: unknown) => setSession(id, patch),
      setBasicAuth: (id: string, ba: unknown) => setBasicAuth(id, ba),
      sessionState: async () => sessionState,
      clearSessionState: async () => null,
      list: async () => allTests,
      importDatasetCsv: (id: string) => importDatasetCsv(id),
    },
    batch: { run: (ids: string[], opts: unknown) => batchRun(ids, opts) },
  },
}));

/* ── Driving the native menus ─────────────────────────────────────────
 *
 * `Add variable` and every variable row's actions are `DropdownMenu`s, which
 * are backed by REAL macOS menus: the items never enter the DOM, so no query
 * can reach them and a click on the trigger is only half the gesture. The
 * trigger hands a plain-data template to `glazeAPI.Menu.popup` and runs the
 * handler for whichever `commandId` comes back — an ordinary promise this test
 * can answer, which is what makes it the REAL handler rather than a stand-in.
 * Same technique the settings panes use for their selects (appearance-pane).
 */
interface NativeItem {
  label?: string;
  commandId?: number;
  submenu?: NativeItem[];
}

/** Depth-first, because `Change type` is a submenu. */
function commandIdFor(items: NativeItem[], label: RegExp): number | undefined {
  for (const item of items) {
    if (item.label && item.commandId !== undefined && label.test(item.label)) return item.commandId;
    if (item.submenu) {
      const nested = commandIdFor(item.submenu, label);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/** What the next popup should answer with. Read synchronously inside `popup`,
 *  which the trigger calls during the click. */
let menuPick: RegExp | null = null;
/** Every template the panel has popped, so a test can assert on what was
 *  OFFERED as well as on what choosing it did. */
let menuTemplates: NativeItem[][] = [];

const popup = vi.fn(async (options?: { items?: NativeItem[] }) => {
  const items = options?.items ?? [];
  menuTemplates.push(items);
  return menuPick ? { commandId: commandIdFor(items, menuPick) } : {};
});

/** Open the menu named by `trigger` and choose the item matching `item`. */
async function chooseFromMenu(trigger: RegExp, item: RegExp): Promise<void> {
  const button = await screen.findByRole("button", { name: trigger });
  menuPick = item;
  fireEvent.click(button);
  menuPick = null;
}

/** Open a menu and choose nothing — for asserting on what it OFFERED. */
async function openMenu(trigger: RegExp): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: trigger }));
}

/** The template the last opened menu offered, as labels (submenus flattened
 *  with their parent's name, so "Change type ▸ Secret" reads as one string). */
function lastMenuLabels(): string[] {
  const items = menuTemplates[menuTemplates.length - 1] ?? [];
  const out: string[] = [];
  for (const i of items) {
    if (i.submenu) out.push(...i.submenu.map((s) => `${i.label} ${s.label}`));
    else if (i.label) out.push(i.label);
  }
  return out;
}

function makeTest(partial: Partial<TestRecord> = {}): TestRecord {
  return {
    id: "t1",
    name: "Checkout",
    url: "https://example.com",
    createdAt: 1,
    updatedAt: 1,
    steps: [],
    scriptPath: "/tmp/t1.spec.ts",
    ...partial,
  } as TestRecord;
}

function renderPanel(test: TestRecord) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <VariablesPanel test={test} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearToastCalls();
  secretStatus = [];
  sessionState = null;
  allTests = [];
  menuPick = null;
  menuTemplates = [];
  (window as unknown as { glazeAPI: { Menu: unknown } }).glazeAPI = { Menu: { popup } };
});

describe("VariablesPanel", () => {
  it("invites the user to add a variable when there are none", async () => {
    renderPanel(makeTest());
    expect(await screen.findByText(/No variables yet/i)).toBeTruthy();
  });

  it("renders a plain variable's value in an editable field", async () => {
    renderPanel(makeTest({ variables: [{ name: "email", kind: "plain", value: "a@b.com" }] }));
    const field = (await screen.findByLabelText("Default value for email")) as HTMLInputElement;
    expect(field.value).toBe("a@b.com");
  });

  it("never renders a secret's value, and offers no way to read one back", async () => {
    secretStatus = [{ name: "password", hasValue: true }];
    renderPanel(makeTest({ variables: [{ name: "password", kind: "secret" }] }));

    // The panel says a value is stored...
    expect(await screen.findByText(/A value is stored, encrypted on this Mac/i)).toBeTruthy();
    // ...and offers only to clear it. No value input, no reveal control.
    expect(screen.queryByLabelText("Value for password")).toBeNull();
    expect(screen.getByRole("button", { name: /clear/i })).toBeTruthy();
    // The plain-variable value field must not exist for a secret either — that
    // field is bound to variable.value, which would render the stored value if
    // one ever leaked onto the record.
    expect(screen.queryByLabelText("Default value for password")).toBeNull();
  });

  it("offers a password-masked input for a secret with no value yet", async () => {
    secretStatus = [{ name: "password", hasValue: false }];
    renderPanel(makeTest({ variables: [{ name: "password", kind: "secret" }] }));

    const input = (await screen.findByLabelText("Value for password")) as HTMLInputElement;
    // Masked, so a shoulder-surfer or a screen recording doesn't capture it.
    expect(input.type).toBe("password");

    fireEvent.change(input, { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(setSecret).toHaveBeenCalledWith("t1", "password", "hunter2"));
  });

  it("shows how many steps reference a variable", async () => {
    renderPanel(
      makeTest({
        variables: [{ name: "email", kind: "plain", value: "a@b.com" }],
        steps: [
          { id: "s1", type: "fill", timestamp: 0, value: "${email}", varRefs: ["email"] },
          { id: "s2", type: "fill", timestamp: 0, value: "${email}", varRefs: ["email"] },
          { id: "s3", type: "click", timestamp: 0 },
        ],
      }),
    );
    expect(await screen.findByText("used by 2 steps")).toBeTruthy();
  });

  it("shows a generator picker for a generated variable, and no value field", async () => {
    renderPanel(
      makeTest({ variables: [{ name: "userEmail", kind: "generated", genSpec: "email" }] }),
    );
    // The generator select renders with the chosen spec...
    expect(await screen.findByLabelText("Generator for userEmail")).toBeTruthy();
    // ...and there is NO default-value input: a stored value would read as
    // load-bearing while never being used (fresh-per-run is the contract).
    expect(screen.queryByLabelText("Default value for userEmail")).toBeNull();
    expect(screen.getByText(/fresh value every run/i)).toBeTruthy();
  });

  it("offers the TOTP choice on a secret and saves it through the same list", async () => {
    // A secret is a password OR a TOTP setup key and never both, which is a
    // segmented control's exact shape — it replaced a checkbox whose meaning
    // lived in a three-line paragraph beside it. Plain buttons with
    // `aria-pressed`, so `click` works (unlike Radix's TabsTrigger).
    secretStatus = [{ name: "mfa", hasValue: true }];
    renderPanel(makeTest({ variables: [{ name: "mfa", kind: "secret" }] }));
    const group = await screen.findByRole("group", { name: /what mfa holds/i });
    const password = within(group).getByRole("button", { name: "Password" });
    expect(password.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(within(group).getByRole("button", { name: "TOTP key" }));
    await waitFor(() =>
      expect(setVariables).toHaveBeenCalledWith("t1", [
        { name: "mfa", kind: "secret", totp: true },
      ]),
    );
  });

  it("saves the session flags and offers only session-saving tests as sources", async () => {
    allTests = [
      makeTest({ id: "t-login", name: "Login", saveSession: true }),
      makeTest({ id: "t-other", name: "Other" }),
      makeTest({ id: "t1", name: "Checkout", saveSession: true }),
    ];
    renderPanel(makeTest());
    const toggle = await screen.findByLabelText("Save signed-in state after passing runs");
    fireEvent.click(toggle);
    await waitFor(() => expect(setSession).toHaveBeenCalledWith("t1", { saveSession: true }));
    // The source select renders; itself and non-saving tests are not offered.
    // (Native-menu Select: options never enter the DOM, so the pinned
    // behaviour is the candidate FILTER, via the displayed value contract —
    // covered at the IPC layer; here the section and its default render.)
    expect(screen.getByLabelText("Session source")).toBeTruthy();
    expect(screen.getByText(/start signed out/i)).toBeTruthy();
  });

  it("distinguishes fresh, stale, and never-saved state", async () => {
    sessionState = { savedAt: 5, fresh: false };
    renderPanel(makeTest({ saveSession: true }));
    expect(await screen.findByText(/STALE/)).toBeTruthy();
  });

  it("warns about a name that would not survive into the generated spec", async () => {
    renderPanel(makeTest({ variables: [{ name: "has-dash", kind: "plain" }] }));
    expect(await screen.findByText(/Use letters, numbers and underscores/i)).toBeTruthy();
  });

  it("removing a variable saves the list without it", async () => {
    renderPanel(
      makeTest({
        variables: [
          { name: "email", kind: "plain", value: "a@b.com" },
          { name: "region", kind: "plain", value: "eu" },
        ],
      }),
    );
    // Behind the row's menu rather than on a trash icon beside the value
    // field: deleting a variable steps depend on and editing its value are not
    // the same weight of action, and they used to sit in adjacent columns.
    await chooseFromMenu(/actions for email/i, /^Remove email$/);
    await waitFor(() =>
      expect(setVariables).toHaveBeenCalledWith("t1", [
        { name: "region", kind: "plain", value: "eu" },
      ]),
    );
  });

  it("gives dataset rows a column per non-secret variable, and none for a secret", async () => {
    secretStatus = [{ name: "password", hasValue: true }];
    renderPanel(
      makeTest({
        variables: [
          { name: "currency", kind: "plain", value: "GBP" },
          { name: "password", kind: "secret" },
        ],
        datasets: [{ id: "d1", name: "GBP", values: { currency: "GBP" } }],
      }),
    );
    // A per-row column exists for the plain variable...
    expect(await screen.findByLabelText("currency for row GBP")).toBeTruthy();
    // ...and NOT for the secret. A row that could set a secret would put a
    // plaintext credential straight back into tests.json.
    expect(screen.queryByLabelText("password for row GBP")).toBeNull();
  });

  it("cannot add a dataset row before any variable exists", async () => {
    renderPanel(makeTest());
    const addRow = (await screen.findByRole("button", { name: /add row/i })) as HTMLButtonElement;
    expect(addRow.disabled).toBe(true);
    expect(screen.getByText(/Add a variable first/i)).toBeTruthy();
  });

  it("running a sweep asks for every dataset row", async () => {
    renderPanel(
      makeTest({
        variables: [{ name: "currency", kind: "plain", value: "GBP" }],
        datasets: [
          { id: "d1", name: "GBP", values: { currency: "GBP" } },
          { id: "d2", name: "USD", values: { currency: "USD" } },
        ],
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /run sweep/i }));
    await waitFor(() =>
      expect(batchRun).toHaveBeenCalledWith(["t1"], { allDatasets: true }),
    );
  });

  it("disables Run sweep when there are no rows to sweep", async () => {
    renderPanel(makeTest({ variables: [{ name: "currency", kind: "plain" }] }));
    const sweep = (await screen.findByRole("button", { name: /run sweep/i })) as HTMLButtonElement;
    expect(sweep.disabled).toBe(true);
  });

  it("imports a CSV and reports what happened — including every refused column", async () => {
    importDatasetCsv.mockResolvedValueOnce({
      ok: true,
      imported: 2,
      createdVariables: ["city"],
      skippedColumns: [{ name: "password", reason: "secret variable" }],
      raggedRows: 1,
      truncated: false,
    });
    renderPanel(makeTest({ variables: [{ name: "user", kind: "plain" }] }));
    fireEvent.click(await screen.findByRole("button", { name: /import csv/i }));
    await waitFor(() => expect(importDatasetCsv).toHaveBeenCalledWith("t1"));
    const texts = toastTexts().map((t) => t.title);
    expect(texts.some((t) => /Imported 2 rows/.test(t))).toBe(true);
    expect(texts.some((t) => /New variables from columns: city/.test(t))).toBe(true);
    expect(texts.some((t) => /Skipped column "password" — secret variable/.test(t))).toBe(true);
    expect(texts.some((t) => /didn't match the header/.test(t))).toBe(true);
    // The created variable appears in the LIST, not just the toast — the list
    // renders from a local draft that import must append to.
    expect(await screen.findByLabelText("Default value for city")).toBeTruthy();
  });

  it("says nothing at all when the picker was cancelled", async () => {
    // "Imported 0 rows" to somebody who pressed Cancel reports on a thing
    // they did not do — the same rule the folder importer follows.
    importDatasetCsv.mockResolvedValueOnce({
      ok: false,
      canceled: true,
      imported: 0,
      createdVariables: [],
      skippedColumns: [],
      raggedRows: 0,
      truncated: false,
    });
    renderPanel(makeTest());
    fireEvent.click(await screen.findByRole("button", { name: /import csv/i }));
    await waitFor(() => expect(importDatasetCsv).toHaveBeenCalled());
    expect(toastTexts()).toEqual([]);
  });

  it("surfaces the parser's reason when nothing could be imported", async () => {
    importDatasetCsv.mockResolvedValueOnce({
      ok: false,
      imported: 0,
      problem: "The file has a header but no data rows.",
      createdVariables: [],
      skippedColumns: [],
      raggedRows: 0,
      truncated: false,
    });
    renderPanel(makeTest());
    fireEvent.click(await screen.findByRole("button", { name: /import csv/i }));
    await waitFor(() =>
      expect(toastTexts().some((t) => /header but no data rows/.test(t.title))).toBe(true),
    );
  });

  it("offers Import CSV even before any variable exists — columns create them", async () => {
    renderPanel(makeTest());
    const btn = (await screen.findByRole("button", { name: /import csv/i })) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
});

describe("creating and renaming variables (drafts stay local until valid)", () => {
  // The backend's normalizeVariables DROPS entries with invalid names. If the
  // panel persists a half-typed row, the save + invalidate cycle deletes it out
  // from under the user — which is exactly how "Add variable" used to do
  // nothing at all. These tests pin the fix: the screen updates instantly, but
  // the backend only ever hears lists it will store verbatim.

  it("adds a variable as an editable local row without persisting an empty name", async () => {
    renderPanel(makeTest());
    await chooseFromMenu(/add variable/i, /^Value$/);
    // The row appears immediately...
    expect((await screen.findByLabelText("Variable name")) as HTMLInputElement).toBeTruthy();
    // ...and nothing was sent: an empty name would be normalized away on write.
    expect(setVariables).not.toHaveBeenCalled();
  });

  it("persists the new variable exactly once its name becomes valid", async () => {
    renderPanel(makeTest());
    await chooseFromMenu(/add variable/i, /^Value$/);
    const name = (await screen.findByLabelText("Variable name")) as HTMLInputElement;

    // "1x" is not a valid identifier — still nothing persisted, row still here.
    fireEvent.change(name, { target: { value: "1x" } });
    expect(setVariables).not.toHaveBeenCalled();
    expect(screen.getByText(/Use letters, numbers and underscores/i)).toBeTruthy();

    // "x1" is valid — exactly one save, carrying the finished name.
    fireEvent.change(name, { target: { value: "x1" } });
    await waitFor(() => expect(setVariables).toHaveBeenCalledTimes(1));
    expect(setVariables).toHaveBeenCalledWith("t1", [{ name: "x1", kind: "plain", value: "" }]);
  });

  it("keeps a variable alive while its name is cleared mid-rename", async () => {
    renderPanel(makeTest({ variables: [{ name: "email", kind: "plain", value: "a@b.com" }] }));
    const name = (await screen.findByLabelText("Variable name")) as HTMLInputElement;

    fireEvent.change(name, { target: { value: "" } });
    // The cleared name must actually show — with the record as the render
    // source it could not, because the prop never carried the keystroke back.
    await waitFor(() =>
      expect((screen.getByLabelText("Variable name") as HTMLInputElement).value).toBe(""),
    );
    // The row survives on screen with its value intact...
    expect((screen.getByLabelText(/Default value for/i) as HTMLInputElement).value).toBe("a@b.com");
    // ...and no save fired — persisting `""` would delete the variable on disk.
    // Flush a tick first so a scheduled mutate can't hide behind the assertion.
    await new Promise((r) => setTimeout(r, 0));
    expect(setVariables).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: "emailAddr" } });
    await waitFor(() =>
      expect(setVariables).toHaveBeenCalledWith("t1", [
        { name: "emailAddr", kind: "plain", value: "a@b.com" },
      ]),
    );
  });

  it("holds a duplicate name locally and says why", async () => {
    renderPanel(makeTest({ variables: [{ name: "email", kind: "plain", value: "a@b.com" }] }));
    await chooseFromMenu(/add variable/i, /^Value$/);
    // The menu answers on a microtask (`popup` is a promise), so the new row
    // is not in the DOM the instant the trigger is clicked.
    await waitFor(() => expect(screen.getAllByLabelText("Variable name")).toHaveLength(2));
    const inputs = screen.getAllByLabelText("Variable name") as HTMLInputElement[];
    fireEvent.change(inputs[1], { target: { value: "email" } });

    // normalizeVariables keeps only the FIRST of a duplicate pair, so this list
    // must not round-trip: nothing saved, and the row explains itself.
    expect(setVariables).not.toHaveBeenCalled();
    expect(screen.getByText(/Already declared above/i)).toBeTruthy();

    fireEvent.change(inputs[1], { target: { value: "email2" } });
    await waitFor(() =>
      expect(setVariables).toHaveBeenCalledWith("t1", [
        { name: "email", kind: "plain", value: "a@b.com" },
        { name: "email2", kind: "plain", value: "" },
      ]),
    );
  });
});

// ── The plaintext notice ──────────────────────────────────────────────────
//
// "Value" is the default kind, and the difference between it and "Secret" is
// invisible on this panel once a row exists: same field, same row, and a
// secret's value is hidden precisely BECAUSE it is safe. The only thing
// telling the user that a password typed into a Value row lands in
// tests.json and in the generated spec is this notice. It renders whether or
// not any variable exists yet, because the decision it warns about is made
// before the first row does.
//
// IT IS BODY COPY NOW, not the amber callout it used to be, and that is the
// property these tests defend from both sides. Its words are unchanged and it
// still renders unconditionally — but a notice that is permanently on screen
// and asks for nothing is not a warning, and sitting in the same amber as the
// two notices that DO require an action taught the eye to skip all three. The
// amber is reserved for those two (see "notices that require an action"
// below); this states a fact.
describe("the plaintext notice", () => {
  /** The notice's own paragraph. Matched on the whole element rather than a
   *  text node: the sentence is broken up by `<strong>` around each kind, so
   *  every text-node query would match only a fragment of it.
   *
   *  Anchored on "Only a", which is the clause that makes this paragraph the
   *  COMPARISON between the kinds rather than one kind's own rule — the
   *  datasets note below is a second paragraph saying rows are plain text too,
   *  and a bare /plain text/ now matches both. */
  function notice(pattern: RegExp): HTMLElement {
    return screen.getByText(
      (_content, el) =>
        el?.tagName === "P" && pattern.test(el.textContent ?? ""),
    );
  }

  it("names which kinds are stored in plain text, and which is not", async () => {
    renderPanel(makeTest());
    await screen.findByText(/Variables/);
    const text = notice(/Only a/).textContent ?? "";
    expect(text).toMatch(/plain text/i);
    expect(text).toMatch(/Value/);
    expect(text).toMatch(/Captured/);
    expect(text).toMatch(/Secret/);
    expect(text).toMatch(/encrypted/i);
  });

  it("warns before any variable exists, not once one does", async () => {
    // The mistake happens while creating the first row. A notice that appeared
    // only after the fact would be a description, not a warning.
    renderPanel(makeTest({ variables: [] }));
    await screen.findByText(/No variables yet/i);
    expect(notice(/Only a/)).toBeTruthy();
  });

  it("states it as body copy, not as a standing alert", async () => {
    // THE REGRESSION THIS PINS: it was a `Callout color="yellow"` with a
    // warning triangle, permanently on screen, asking for nothing. Amber on
    // this tab now means "a run will go ahead wrong unless you do something",
    // and there is exactly one flag treatment — so if this paragraph ever gets
    // it back, the two notices that need it lose their weight.
    renderPanel(makeTest());
    const el = notice(/Only a/);
    expect(el.className).toContain("gl-var-note");
    expect(el.closest(".gl-var-flag")).toBeNull();
    // And nothing else on a freshly opened tab is wearing the flag treatment.
    expect(document.querySelectorAll(".gl-var-flag").length).toBe(0);
  });

  it("says dataset rows are plain text too", async () => {
    // A row cannot supply a secret — `variableHeader` spreads secrets LAST for
    // exactly that reason — so someone reaching for datasets to hold a password
    // needs telling before they type one in.
    renderPanel(makeTest({ variables: [{ name: "email", kind: "plain", value: "a@b.com" }] }));
    expect(await screen.findByText(/Row values are stored as plain text/i)).toBeTruthy();
  });
});

describe("the Reusable flow section", () => {
  it("turns a test into a flow, preserving its declared parameters", async () => {
    renderPanel(makeTest({ flowParams: ["email"] }));
    fireEvent.click(await screen.findByRole("switch", { name: /reusable flow/i }));
    await waitFor(() => expect(setFlow).toHaveBeenCalledWith("t1", true, ["email"]));
  });

  it("offers plain variables as parameters and persists a tick", async () => {
    renderPanel(
      makeTest({
        isFlow: true,
        variables: [{ name: "email", kind: "plain", value: "a@b.com" }],
      }),
    );
    fireEvent.click(await screen.findByLabelText("Parameter email"));
    await waitFor(() => expect(setFlow).toHaveBeenCalledWith("t1", true, ["email"]));
  });

  it("never offers a secret as a parameter", async () => {
    // An argument is stored as plain text on the CALLING test's record, so a
    // secret parameter would route its value around the encrypted store —
    // the same rule that keeps secrets out of dataset columns.
    renderPanel(
      makeTest({
        isFlow: true,
        variables: [
          { name: "email", kind: "plain", value: "a@b.com" },
          { name: "password", kind: "secret" },
        ],
      }),
    );
    await screen.findByLabelText("Parameter email");
    expect(screen.queryByLabelText("Parameter password")).toBeNull();
  });

  it("unticking removes just that parameter", async () => {
    renderPanel(
      makeTest({
        isFlow: true,
        flowParams: ["email", "user"],
        variables: [
          { name: "email", kind: "plain", value: "" },
          { name: "user", kind: "plain", value: "" },
        ],
      }),
    );
    fireEvent.click(await screen.findByLabelText("Parameter email"));
    await waitFor(() => expect(setFlow).toHaveBeenCalledWith("t1", true, ["user"]));
  });

  it("surfaces parameters that no longer match a variable, with a way out", async () => {
    // A parameter whose variable was renamed, deleted, or made secret still
    // binds (callers fall back to ""), but it is probably stale — so it is
    // shown as removable instead of silently kept or silently dropped.
    renderPanel(makeTest({ isFlow: true, flowParams: ["ghost"] }));
    await screen.findByText(/no matching variable/i);
    fireEvent.click(screen.getByRole("button", { name: /remove parameter ghost/i }));
    await waitFor(() => expect(setFlow).toHaveBeenCalledWith("t1", true, []));
  });

  it("says what off means while the toggle is off", async () => {
    renderPanel(makeTest());
    expect(await screen.findByText(/not offered in the trainer/i)).toBeTruthy();
  });
});

// ── Re-pointing a whole test at another site ─────────────────────────
//
// The control exists because Playwright's own `baseURL` cannot move a recorded
// test: the generator emits the recorded ABSOLUTE address, and baseURL resolves
// relative paths only. Declaring the address as a variable is what does move
// it. Every assertion here is about a state the user could otherwise misread.

describe("using a variable for the site address", () => {
  beforeEach(() => {
    originsData = [];
    parameteriseOrigin.mockClear();
  });

  it("offers the address the steps actually point at, and how many places", async () => {
    // The count is the number of edits about to happen — a button that says
    // only "parameterise" asks the user to trust it.
    originsData = [{ origin: "https://shop.example.com", count: 3 }];
    renderPanel(makeTest());
    expect(await screen.findByText(/3 places/)).toBeTruthy();
    expect(screen.getByText("https://shop.example.com")).toBeTruthy();
  });

  it("says `place` for one, so a count of one does not read as a bug", async () => {
    originsData = [{ origin: "https://shop.example.com", count: 1 }];
    renderPanel(makeTest());
    expect(await screen.findByText(/1 place\./)).toBeTruthy();
  });

  it("rewrites when pressed, and reports what changed", async () => {
    originsData = [{ origin: "https://shop.example.com", count: 3 }];
    renderPanel(makeTest());
    const button = await screen.findByRole("button", { name: /use a variable for the site address/i });
    fireEvent.click(button);
    await waitFor(() => expect(parameteriseOrigin).toHaveBeenCalledWith("t1", "https://shop.example.com"));
    await waitFor(() =>
      expect(toastTexts().some((t) => /3 places now use \$\{SITE_URL\}/.test(t.title))).toBe(true),
    );
  });

  it("stops offering the rewrite once it has been done", async () => {
    // THE BUG THIS PINS, found by pressing the button in the preview: the
    // origins query reads the STEPS, and a rewrite changes them without
    // changing their count — so nothing refetched it and the offer survived
    // its own success. A button that stays after doing its job reads as a
    // button that did nothing.
    originsData = [{ origin: "https://shop.example.com", count: 3 }];
    renderPanel(makeTest());
    const button = await screen.findByRole("button", { name: /use a variable for the site address/i });
    originsData = []; // what the backend answers once the URLs reference a variable
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /use a variable for the site address/i })).toBeNull(),
    );
  });

  it("offers nothing when no step points at a literal address", async () => {
    // Already parameterised, or a test with no navigation. Showing a disabled
    // button here would imply there is something to do.
    originsData = [];
    renderPanel(makeTest());
    await screen.findByText("Variables");
    expect(screen.queryByRole("button", { name: /use a variable for the site address/i })).toBeNull();
  });

  it("offers nothing on a hand-edited script, which the steps no longer drive", async () => {
    // The backend refuses this too. Not offering it is the honest half: a
    // rewrite here would change steps that no run reads.
    originsData = [{ origin: "https://shop.example.com", count: 3 }];
    renderPanel(makeTest({ scriptEdited: true }));
    await screen.findByText("Variables");
    expect(screen.queryByRole("button", { name: /use a variable for the site address/i })).toBeNull();
  });
});

describe("HTTP basic auth", () => {
  // The Select's options are native-menu-backed and never enter the DOM, so
  // the chosen secret is seeded through the record (`test.basicAuth`) and the
  // assertions drive the username field and the two buttons.
  const withSecret = () =>
    makeTest({
      variables: [{ name: "wallPw", kind: "secret" }],
      basicAuth: { username: "admin", passwordVar: "wallPw" },
    });

  it("asks for a secret variable first when none is declared", async () => {
    renderPanel(makeTest());
    expect(
      await screen.findByText(/Declare a .*variable above to hold the password/i),
    ).toBeTruthy();
  });

  it("saves the username against the chosen secret, and never a password value", async () => {
    secretStatus = [{ name: "wallPw", hasValue: true }];
    renderPanel(withSecret());
    const user = (await screen.findByLabelText("Basic auth username")) as HTMLInputElement;
    expect(user.value).toBe("admin");
    fireEvent.change(user, { target: { value: "root" } });
    fireEvent.click(screen.getByRole("button", { name: /save basic auth/i }));
    await waitFor(() => expect(setBasicAuth).toHaveBeenCalledTimes(1));
    const [, payload] = setBasicAuth.mock.calls[0];
    expect(payload).toEqual({ username: "root", passwordVar: "wallPw" });
    // The payload names the secret; no password value exists anywhere in it.
    expect(JSON.stringify(payload)).not.toMatch(/password"?\s*:/i);
  });

  it("clears with null, so the backend deletes rather than stores an empty", async () => {
    secretStatus = [{ name: "wallPw", hasValue: true }];
    renderPanel(withSecret());
    fireEvent.click(await screen.findByRole("button", { name: /clear basic auth/i }));
    await waitFor(() => expect(setBasicAuth).toHaveBeenCalledWith("t1", null));
  });

  it("warns when the chosen secret has no stored value yet", async () => {
    secretStatus = [{ name: "wallPw", hasValue: false }];
    renderPanel(withSecret());
    expect(await screen.findByText(/has no stored value yet/i)).toBeTruthy();
  });

  it("warns when the referenced secret is no longer declared", async () => {
    renderPanel(
      makeTest({
        variables: [{ name: "wallPw", kind: "secret" }],
        basicAuth: { username: "admin", passwordVar: "goneVar" },
      }),
    );
    expect(await screen.findByText(/No secret variable named/i)).toBeTruthy();
  });
});


// ── The kind groups ───────────────────────────────────────────────────────
//
// The kinds are DRAWN as four groups and STORED as one list. Everything here
// defends that split: what the user sees is grouped by what may be done to a
// variable, while the namespace, the duplicate rule and the saved order stay
// whole-list properties. Get it wrong in the other direction — group the data
// rather than the view — and an edit in one group writes over a variable in
// another, which is the failure these tests exist to catch.

describe("the kind groups", () => {
  it("draws each kind in its own group, under the rule that kind is stored by", async () => {
    secretStatus = [{ name: "password", hasValue: true }];
    renderPanel(
      makeTest({
        variables: [
          { name: "site", kind: "plain", value: "https://x.test" },
          { name: "password", kind: "secret" },
          { name: "orderNo", kind: "captured" },
          { name: "runId", kind: "generated", genSpec: "uuid" },
        ],
      }),
    );
    // Each group is a landmark with its own name, so "which of these am I
    // acting on" is answerable without reading the row.
    const secrets = await screen.findByRole("region", { name: "Secrets" });
    expect(within(secrets).getByLabelText("Variable name")).toBeTruthy();
    expect(secrets.textContent).toMatch(/Encrypted on this Mac/i);

    const values = screen.getByRole("region", { name: "Values" });
    expect(values.textContent).toMatch(/Plain text, in this test's record/i);
    expect(screen.getByRole("region", { name: "Captured" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Generated" })).toBeTruthy();
  });

  it("draws no group for a kind this test does not use", async () => {
    // Four empty boxes above a test with one variable would be a legend of the
    // type system rather than a list of this test's variables. An unused kind
    // is reached through the panel header's menu instead.
    renderPanel(makeTest({ variables: [{ name: "site", kind: "plain", value: "" }] }));
    expect(await screen.findByRole("region", { name: "Values" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Secrets" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Generated" })).toBeNull();
  });

  it("names the kind when the variable is created, not after", async () => {
    // The safety path: declaring a password as a Secret from the start, rather
    // than typing it into a Value row and converting afterwards — by which
    // point it has already been written to the record in plaintext.
    renderPanel(makeTest());
    await chooseFromMenu(/add variable/i, /^Secret$/);
    const secrets = await screen.findByRole("region", { name: "Secrets" });
    fireEvent.change(within(secrets).getByLabelText("Variable name"), {
      target: { value: "apiToken" },
    });
    await waitFor(() =>
      expect(setVariables).toHaveBeenCalledWith("t1", [{ name: "apiToken", kind: "secret" }]),
    );
  });

  it("offers every kind on the add menu", async () => {
    renderPanel(makeTest());
    await openMenu(/add variable/i);
    expect(lastMenuLabels()).toEqual([
      "Value",
      "Secret",
      "Captured at run time",
      "Generated each run",
    ]);
  });

  it("adds into the group whose own control was used", async () => {
    renderPanel(makeTest({ variables: [{ name: "site", kind: "plain", value: "" }] }));
    fireEvent.click(await screen.findByRole("button", { name: "Add to Values" }));
    await waitFor(() =>
      expect(screen.getAllByLabelText("Variable name").length).toBe(2),
    );
    // Still one group: the new row is a Value, because that is the group its
    // control belongs to.
    expect(screen.queryByRole("region", { name: "Secrets" })).toBeNull();
  });

  it("keeps ONE namespace across the groups", async () => {
    // A `${name}` reference does not care which group the variable is drawn
    // in, so a plain `email` and a secret `email` collide exactly as two plain
    // ones would — and the list must not round-trip until one is renamed.
    renderPanel(makeTest({ variables: [{ name: "email", kind: "plain", value: "a@b.com" }] }));
    await chooseFromMenu(/add variable/i, /^Secret$/);
    const secrets = await screen.findByRole("region", { name: "Secrets" });
    fireEvent.change(within(secrets).getByLabelText("Variable name"), {
      target: { value: "email" },
    });

    expect(setVariables).not.toHaveBeenCalled();
    expect(within(secrets).getByText(/Already declared above/i)).toBeTruthy();
  });

  it("offers every kind but the one the row already is", async () => {
    renderPanel(makeTest({ variables: [{ name: "site", kind: "plain", value: "" }] }));
    await openMenu(/actions for site/i);
    const labels = lastMenuLabels();
    expect(labels).toContain("Change type Secret");
    expect(labels).toContain("Change type Captured at run time");
    expect(labels).not.toContain("Change type Value");
    expect(labels).toContain("Remove site");
  });

  it("writes a kind change back into the variable's stored position", async () => {
    // The groups reorder what is DRAWN. If a change wrote back by the position
    // within its group, changing the second Value would rewrite whichever
    // variable happened to sit second in the whole list.
    renderPanel(
      makeTest({
        variables: [
          { name: "site", kind: "plain", value: "https://x.test" },
          { name: "token", kind: "plain", value: "" },
        ],
      }),
    );
    await chooseFromMenu(/actions for token/i, /^Generated each run$/);
    await waitFor(() =>
      expect(setVariables).toHaveBeenCalledWith("t1", [
        { name: "site", kind: "plain", value: "https://x.test" },
        { name: "token", kind: "generated", genSpec: "string" },
      ]),
    );
  });

  it("drops the plaintext value when a variable becomes a secret", async () => {
    // `normalizeVariables` refuses to store a secret's value, so the record is
    // safe either way — but leaving it in the local draft would keep the
    // password on screen under a legend promising it is encrypted, and would
    // put it back on the record the moment any other edit saved the list.
    renderPanel(makeTest({ variables: [{ name: "password", kind: "plain", value: "hunter2" }] }));
    await chooseFromMenu(/actions for password/i, /^Secret$/);
    await waitFor(() =>
      expect(setVariables).toHaveBeenCalledWith("t1", [{ name: "password", kind: "secret" }]),
    );
    expect(JSON.stringify(setVariables.mock.calls)).not.toMatch(/hunter2/);
    // And the field that held it is gone from the screen with it.
    expect(screen.queryByLabelText("Default value for password")).toBeNull();
  });
});

// ── Notices that require an action ────────────────────────────────────────
//
// The whole point of demoting the standing callout: amber on this tab now
// means "this saved, and the next run will go ahead wrong unless you do
// something". If it appears for anything else it stops meaning that.

describe("notices that require an action", () => {
  it("flags a secret with no value once steps read it", async () => {
    secretStatus = [{ name: "apiToken", hasValue: false }];
    renderPanel(
      makeTest({
        variables: [{ name: "apiToken", kind: "secret" }],
        steps: [
          { id: "s1", type: "fill", timestamp: 0, value: "${apiToken}", varRefs: ["apiToken"] },
          { id: "s2", type: "fill", timestamp: 0, value: "${apiToken}", varRefs: ["apiToken"] },
        ],
      }),
    );
    const flag = await screen.findByText(/No value stored/i);
    expect(flag.closest(".gl-var-flag")?.getAttribute("data-tier")).toBe("action");
    expect(flag.textContent).toMatch(/2 steps/);
  });

  it("says nothing about a secret nothing reads yet", async () => {
    // A secret just declared has its own input on screen and nothing depending
    // on it. Warning here would fire on every new secret, at which point the
    // colour stops being a signal.
    secretStatus = [{ name: "apiToken", hasValue: false }];
    renderPanel(makeTest({ variables: [{ name: "apiToken", kind: "secret" }] }));
    await screen.findByLabelText("Value for apiToken");
    expect(screen.queryByText(/No value stored/i)).toBeNull();
  });

  it("marks a name that will not save as blocking, not merely actionable", async () => {
    // The two tiers are not decoration: blocking means the list is being held
    // back from the backend until it is fixed, which is a different thing to
    // do about it than "a run will be wrong".
    renderPanel(makeTest({ variables: [{ name: "has-dash", kind: "plain" }] }));
    const flag = await screen.findByText(/Use letters, numbers and underscores/i);
    expect(flag.closest(".gl-var-flag")?.getAttribute("data-tier")).toBe("blocking");
  });
});

// ── Datasets, as a table ──────────────────────────────────────────────────

describe("the dataset table", () => {
  it("gives every non-secret variable a column header", async () => {
    // The question the section exists to answer — what is `currency` on each
    // row — is a column. As a card per row with a wrapping field cluster in
    // each, it could only be answered by reading every card in turn.
    secretStatus = [{ name: "password", hasValue: true }];
    renderPanel(
      makeTest({
        variables: [
          { name: "currency", kind: "plain", value: "GBP" },
          { name: "orderNo", kind: "captured" },
          { name: "password", kind: "secret" },
        ],
        datasets: [{ id: "d1", name: "GBP", values: { currency: "GBP" } }],
      }),
    );
    expect(await screen.findByRole("columnheader", { name: "currency" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "orderNo" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "password" })).toBeNull();
  });

  it("puts one row per dataset row, addressable by row and column", async () => {
    renderPanel(
      makeTest({
        variables: [{ name: "currency", kind: "plain", value: "GBP" }],
        datasets: [
          { id: "d1", name: "Sterling", values: { currency: "GBP" } },
          { id: "d2", name: "Dollars", values: { currency: "USD" } },
        ],
      }),
    );
    expect(
      ((await screen.findByLabelText("currency for row Dollars")) as HTMLInputElement).value,
    ).toBe("USD");
    fireEvent.click(screen.getByLabelText("Remove row Sterling"));
    await waitFor(() =>
      expect(setDatasets).toHaveBeenCalledWith("t1", [
        { id: "d2", name: "Dollars", values: { currency: "USD" } },
      ]),
    );
  });
});
