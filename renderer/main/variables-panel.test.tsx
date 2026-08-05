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

import type { SecretStatus, TestRecord } from "../lib/recorder-types";
import { VariablesPanel } from "./variables-panel";

const setVariables = vi.fn(async (_id: string, _v: unknown) => ({}) as TestRecord);
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
let secretStatus: SecretStatus[] = [];

vi.mock("../lib/api", () => ({
  api: {
    tests: {
      setVariables: (id: string, v: unknown) => setVariables(id, v),
      setDatasets: (id: string, d: unknown) => setDatasets(id, d),
      setSecret: (id: string, name: string, value: string) => setSecret(id, name, value),
      clearSecret: (id: string, name: string) => clearSecret(id, name),
      secretStatus: async () => secretStatus,
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
  secretStatus = [];
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
});
