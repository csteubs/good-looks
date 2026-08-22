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
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
      sessionState: async () => sessionState,
      clearSessionState: async () => null,
      list: async () => allTests,
      importDatasetCsv: (id: string) => importDatasetCsv(id),
    },
    batch: { run: (ids: string[], opts: unknown) => batchRun(ids, opts) },
  },
}));

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

  it("offers the TOTP flag on a secret and saves it through the same list", async () => {
    secretStatus = [{ name: "mfa", hasValue: true }];
    renderPanel(makeTest({ variables: [{ name: "mfa", kind: "secret" }] }));
    const box = await screen.findByLabelText("TOTP key for mfa");
    fireEvent.click(box);
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
    fireEvent.click(await screen.findByLabelText("Remove email"));
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
    fireEvent.click(await screen.findByRole("button", { name: /add variable/i }));
    // The row appears immediately...
    expect((await screen.findByLabelText("Variable name")) as HTMLInputElement).toBeTruthy();
    // ...and nothing was sent: an empty name would be normalized away on write.
    expect(setVariables).not.toHaveBeenCalled();
  });

  it("persists the new variable exactly once its name becomes valid", async () => {
    renderPanel(makeTest());
    fireEvent.click(await screen.findByRole("button", { name: /add variable/i }));
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
    fireEvent.click(await screen.findByRole("button", { name: /add variable/i }));
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

// ── The plaintext warning ─────────────────────────────────────────────────
//
// "Value" is the default kind, and the difference between it and "Secret" is
// invisible on this panel once a row exists: same field, same row, and a
// secret's value is hidden precisely BECAUSE it is safe. The only thing
// telling the user that a password typed into a Value row lands in
// tests.json and in the generated spec is this notice. It renders whether or
// not any variable exists yet, because the decision it warns about is made
// before the first row does.
describe("the plaintext warning", () => {
  /** The notice's own paragraph. Matched on the whole element rather than a
   *  text node: the sentence is broken up by `<strong>` around each kind, so
   *  every text-node query would match only a fragment of it. */
  function notice(pattern: RegExp): HTMLElement {
    return screen.getByText(
      (_content, el) =>
        el?.tagName === "P" && pattern.test(el.textContent ?? ""),
    );
  }

  it("names which kinds are stored in plain text, and which is not", async () => {
    renderPanel(makeTest());
    await screen.findByText(/Variables/);
    const text = notice(/plain text/i).textContent ?? "";
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
    expect(notice(/plain text/i)).toBeTruthy();
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
