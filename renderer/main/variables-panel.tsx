// Variables + Datasets tab on a test's detail view.
//
// Three kinds of variable share one list because they share one namespace in
// the generated spec — a `${name}` reference doesn't care where the value came
// from, and letting the user see them together is what makes it obvious that
// declaring `email` twice is a mistake.
//
//   • plain     — a default value stored on the record.
//   • secret    — the value lives encrypted backend-side and NEVER comes back
//                 over IPC. The UI can only say whether one is set, and set or
//                 clear it. That asymmetry is the feature, not a limitation.
//   • captured  — written during the run by a `capture` step; any value here is
//                 only a fallback for steps that read it before the capture.
//
// Datasets are rows over the plain/captured variables. Running a sweep queues
// the test once per row, so a failure can be attributed to a specific row
// rather than showing up as flake.

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Input,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
  toast,
} from "@glaze/core/components";
import { KeyRound, Play, Plus, Trash2, Variable } from "lucide-react";

import { api } from "../lib/api";
import {
  VARIABLE_KIND_LABELS,
  VARIABLE_KINDS,
  type Dataset,
  type TestRecord,
  type TestVariable,
  type VariableKind,
} from "../lib/recorder-types";

/** Mirror of `isValidVariableName` in main/recorder/types.ts.
 *
 *  Duplicated rather than shared because the backend normalizes on write and is
 *  the source of truth — this copy exists only so the UI can say "that name
 *  won't work" before the round-trip, instead of silently dropping the entry. */
function isValidName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.length <= 40;
}

/** A short, stable id for a new dataset row. Rows are user-visible things that
 *  outlive renames, so they can't be keyed by name. */
function newRowId(): string {
  return `d-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function VariableRow({
  variable,
  hasSecret,
  usedBy,
  onChange,
  onRemove,
  onSetSecret,
  onClearSecret,
}: {
  variable: TestVariable;
  hasSecret: boolean;
  /** how many steps reference this variable — deleting one that's in use is
   *  the mistake worth warning about */
  usedBy: number;
  onChange: (next: TestVariable) => void;
  onRemove: () => void;
  onSetSecret: (value: string) => void;
  onClearSecret: () => void;
}) {
  const [secretDraft, setSecretDraft] = React.useState("");
  const nameOk = isValidName(variable.name);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-separator p-3">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Variable name"
          value={variable.name}
          placeholder="name"
          className="w-48 font-mono"
          onChange={(e) => onChange({ ...variable, name: e.target.value })}
        />
        <Select
          value={variable.kind}
          onValueChange={(v) => onChange({ ...variable, kind: v as VariableKind })}
        >
          <SelectTrigger aria-label="Variable kind" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VARIABLE_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {VARIABLE_KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {usedBy > 0 ? (
          <Badge variant="secondary">
            used by {usedBy} step{usedBy === 1 ? "" : "s"}
          </Badge>
        ) : null}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="small"
          aria-label={`Remove ${variable.name || "variable"}`}
          onClick={onRemove}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      {!nameOk && variable.name !== "" ? (
        <Text size="small" className="text-danger">
          Use letters, numbers and underscores, starting with a letter — the name becomes a
          property in the generated spec.
        </Text>
      ) : null}

      {variable.kind === "secret" ? (
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-tertiary" />
          {hasSecret ? (
            <>
              <Text size="small" className="text-secondary">
                A value is stored, encrypted on this Mac. It is never shown again, never written
                into the spec, and never sent anywhere.
              </Text>
              <div className="flex-1" />
              <Button variant="ghost" size="small" onClick={onClearSecret}>
                Clear
              </Button>
            </>
          ) : (
            <>
              <Input
                aria-label={`Value for ${variable.name}`}
                type="password"
                value={secretDraft}
                placeholder="Value (stored encrypted)"
                className="flex-1"
                onChange={(e) => setSecretDraft(e.target.value)}
              />
              <Button
                size="small"
                disabled={!secretDraft || !nameOk}
                onClick={() => {
                  onSetSecret(secretDraft);
                  setSecretDraft("");
                }}
              >
                Save
              </Button>
            </>
          )}
        </div>
      ) : (
        <Input
          aria-label={`Default value for ${variable.name || "variable"}`}
          value={variable.value ?? ""}
          placeholder={
            variable.kind === "captured"
              ? "Fallback before the capture runs (optional)"
              : "Value"
          }
          onChange={(e) => onChange({ ...variable, value: e.target.value })}
        />
      )}
    </div>
  );
}

export function VariablesPanel({ test }: { test: TestRecord }) {
  const qc = useQueryClient();
  const variables = React.useMemo(() => test.variables ?? [], [test.variables]);
  const datasets = React.useMemo(() => test.datasets ?? [], [test.datasets]);

  const secrets = useQuery({
    queryKey: ["secretStatus", test.id],
    queryFn: () => api.tests.secretStatus(test.id),
  });
  const storedSecrets = React.useMemo(
    () => new Set((secrets.data ?? []).filter((s) => s.hasValue).map((s) => s.name)),
    [secrets.data],
  );

  // How many steps reference each variable, so removing one that's still in use
  // can be called out rather than silently breaking the spec.
  const usage = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const step of test.steps) {
      for (const name of step.varRefs ?? []) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    return counts;
  }, [test.steps]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["test", test.id] });
    void qc.invalidateQueries({ queryKey: ["tests"] });
  };

  const saveVariables = useMutation({
    mutationFn: (next: TestVariable[]) => api.tests.setVariables(test.id, next),
    onSuccess: invalidate,
    onError: (err: unknown) => toast.error(String(err)),
  });

  const saveDatasets = useMutation({
    mutationFn: (next: Dataset[]) => api.tests.setDatasets(test.id, next),
    onSuccess: invalidate,
    onError: (err: unknown) => toast.error(String(err)),
  });

  const setSecret = useMutation({
    mutationFn: (p: { name: string; value: string }) =>
      api.tests.setSecret(test.id, p.name, p.value),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["secretStatus", test.id] });
      toast.success("Secret saved");
    },
    onError: (err: unknown) => toast.error(String(err)),
  });

  const clearSecret = useMutation({
    mutationFn: (name: string) => api.tests.clearSecret(test.id, name),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["secretStatus", test.id] }),
    onError: (err: unknown) => toast.error(String(err)),
  });

  const runSweep = useMutation({
    mutationFn: () => api.batch.run([test.id], { allDatasets: true }),
    onSuccess: () => toast.success("Sweep started — watch it in the Batch view"),
    onError: (err: unknown) => toast.error(String(err)),
  });

  // Only plain/captured variables get dataset columns: a secret's value comes
  // from the encrypted store, and a row that could override it would put a
  // plaintext credential straight back into tests.json.
  const columns = variables.filter((v) => v.kind !== "secret").map((v) => v.name);

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-6 p-4">
        {/* ── Variables ─────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Variable className="size-4 text-secondary" />
            <Text weight="medium">Variables</Text>
            <div className="flex-1" />
            <Button
              size="small"
              variant="secondary"
              onClick={() =>
                saveVariables.mutate([...variables, { name: "", kind: "plain", value: "" }])
              }
            >
              <Plus className="size-4" />
              Add variable
            </Button>
          </div>
          <Text size="small" className="text-secondary">
            Reference a variable from any step value with{" "}
            <code className="font-mono">{"${name}"}</code>.
          </Text>

          {variables.length === 0 ? (
            <Text size="small" className="text-tertiary">
              No variables yet. Add one to reuse a value across steps, keep a password out of the
              generated spec, or run this test over several rows of data.
            </Text>
          ) : (
            <div className="flex flex-col gap-2">
              {variables.map((v, i) => (
                <VariableRow
                  key={i}
                  variable={v}
                  hasSecret={storedSecrets.has(v.name)}
                  usedBy={usage.get(v.name) ?? 0}
                  onChange={(next) => {
                    const copy = [...variables];
                    copy[i] = next;
                    saveVariables.mutate(copy);
                  }}
                  onRemove={() => saveVariables.mutate(variables.filter((_, j) => j !== i))}
                  onSetSecret={(value) => setSecret.mutate({ name: v.name, value })}
                  onClearSecret={() => clearSecret.mutate(v.name)}
                />
              ))}
            </div>
          )}
        </section>

        {/* ── Datasets ──────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Text weight="medium">Datasets</Text>
            <div className="flex-1" />
            <Button
              size="small"
              variant="secondary"
              disabled={columns.length === 0}
              onClick={() =>
                saveDatasets.mutate([
                  ...datasets,
                  { id: newRowId(), name: `Row ${datasets.length + 1}`, values: {} },
                ])
              }
            >
              <Plus className="size-4" />
              Add row
            </Button>
            <Button
              size="small"
              disabled={datasets.length === 0 || runSweep.isPending}
              onClick={() => runSweep.mutate()}
            >
              <Play className="size-4" />
              Run sweep
            </Button>
          </div>
          <Text size="small" className="text-secondary">
            Each row runs the test once with its own values, and is recorded as its own run — so a
            failure points at a row rather than looking like flake.
          </Text>

          {columns.length === 0 ? (
            <Text size="small" className="text-tertiary">
              Add a variable first — rows supply values for the variables this test declares.
            </Text>
          ) : datasets.length === 0 ? (
            <Text size="small" className="text-tertiary">
              No rows yet.
            </Text>
          ) : (
            <div className="flex flex-col gap-2">
              {datasets.map((row, i) => (
                <div
                  key={row.id}
                  className="flex flex-col gap-2 rounded-md border border-separator p-3"
                >
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label={`Name for row ${i + 1}`}
                      value={row.name}
                      placeholder="Row name"
                      className="w-56"
                      onChange={(e) => {
                        const copy = [...datasets];
                        copy[i] = { ...row, name: e.target.value };
                        saveDatasets.mutate(copy);
                      }}
                    />
                    <div className="flex-1" />
                    <Button
                      variant="ghost"
                      size="small"
                      aria-label={`Remove row ${row.name}`}
                      onClick={() => saveDatasets.mutate(datasets.filter((_, j) => j !== i))}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {columns.map((name) => (
                      <div key={name} className="flex flex-col gap-1">
                        <Text size="small" className="font-mono text-tertiary">
                          {name}
                        </Text>
                        <Input
                          aria-label={`${name} for row ${row.name}`}
                          value={row.values[name] ?? ""}
                          onChange={(e) => {
                            const copy = [...datasets];
                            copy[i] = {
                              ...row,
                              values: { ...row.values, [name]: e.target.value },
                            };
                            saveDatasets.mutate(copy);
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </ScrollArea>
  );
}
