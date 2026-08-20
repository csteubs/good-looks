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
//   • generated — a fresh value on every run (glazeGenerate in the V header).
//                 No stored value at all: the record keeps only WHAT to
//                 generate (genSpec), and the run log records what was used.
//
// Datasets are rows over the plain/captured variables. Running a sweep queues
// the test once per row, so a failure can be attributed to a specific row
// rather than showing up as flake.

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Input,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Text,
  toast,
} from "@ui";
import { FileUp, KeyRound, Play, Plus, Trash2, TriangleAlert, Variable, Workflow } from "lucide-react";

import { api } from "../lib/api";
import {
  GEN_SPEC_LABELS,
  GEN_SPECS,
  VARIABLE_KIND_LABELS,
  VARIABLE_KINDS,
  type Dataset,
  type GenSpec,
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
  duplicate,
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
  /** an earlier row already claims this name; the backend would keep only the
   *  first, so this row is held locally until it's renamed */
  duplicate: boolean;
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
        <Text size="small" className="text-support-red">
          Use letters, numbers and underscores, starting with a letter — the name becomes a
          property in the generated spec.
        </Text>
      ) : null}

      {nameOk && duplicate ? (
        <Text size="small" className="text-support-red">
          Already declared above — rename this one, or it won&apos;t be saved.
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
      ) : variable.kind === "generated" ? (
        <div className="flex items-center gap-2">
          <Select
            value={variable.genSpec ?? "string"}
            onValueChange={(v) => onChange({ ...variable, genSpec: v as GenSpec })}
          >
            <SelectTrigger aria-label={`Generator for ${variable.name || "variable"}`} className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GEN_SPECS.map((g) => (
                <SelectItem key={g} value={g}>
                  {GEN_SPEC_LABELS[g]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Text size="small" className="text-secondary">
            A fresh value every run — the run log records what was used. A dataset row naming
            this variable pins it instead.
          </Text>
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
  // Local-first working copy, seeded once per test id (the same latch idiom the
  // run controls use). The backend's normalizeVariables silently DROPS entries
  // whose names aren't valid identifiers — so when the record was the render
  // source, saving a half-typed row ("", "1x") and re-reading deleted the row
  // out from under the user. "Add variable" could never survive at all: it
  // persisted an empty name, the normalizer dropped it, and the invalidation
  // wiped the fresh row before it could be named.
  const [vars, setVars] = React.useState<TestVariable[]>(() => test.variables ?? []);
  const [seededFor, setSeededFor] = React.useState(test.id);
  if (seededFor !== test.id) {
    setSeededFor(test.id);
    setVars(test.variables ?? []);
  }
  const variables = vars;
  const datasets = React.useMemo(() => test.datasets ?? [], [test.datasets]);

  // Names an EARLIER row already claims. The normalizer keeps the first of a
  // duplicate pair, so a list containing one wouldn't round-trip losslessly.
  const duplicateAt = React.useMemo(() => {
    const seen = new Set<string>();
    return variables.map((v) => {
      const dup = seen.has(v.name);
      seen.add(v.name);
      return dup;
    });
  }, [variables]);

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

  /** Every edit lands here: the screen always updates, the backend only hears
   *  about lists it will store verbatim. A list with an invalid or duplicate
   *  name stays local — the row keeps rendering with its warning — instead of
   *  being normalized away on write and erased by the refetch. */
  const applyVariables = (next: TestVariable[]) => {
    setVars(next);
    const names = next.map((v) => v.name);
    const lossless =
      names.every((n) => isValidName(n)) && new Set(names).size === names.length;
    if (lossless) saveVariables.mutate(next);
  };

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

  const importCsv = useMutation({
    mutationFn: () => api.tests.importDatasetCsv(test.id),
    onSuccess: (res) => {
      if (res.canceled) return;
      if (!res.ok) {
        toast.error(res.problem ?? "Nothing was imported.");
        return;
      }
      invalidate();
      toast.success(
        res.imported === 1 ? "Imported 1 row." : `Imported ${res.imported} rows.`,
      );
      if (res.createdVariables.length > 0) {
        // The list renders from the LOCAL draft (see `vars` above), which only
        // reseeds when the test changes — so variables the import just created
        // on the record are appended here too, or the list would sit empty
        // under a toast announcing them.
        setVars((prev) => [
          ...prev,
          ...res.createdVariables
            .filter((name) => !prev.some((v) => v.name === name))
            .map((name) => ({ name, kind: "plain" as const, value: "" })),
        ]);
        toast.success(`New variables from columns: ${res.createdVariables.join(", ")}`);
      }
      // Everything refused or reshaped is said out loud — a silently dropped
      // password column would read as "the import ate my data".
      for (const col of res.skippedColumns) {
        toast.warning(`Skipped column "${col.name}" — ${col.reason}.`);
      }
      if (res.raggedRows > 0) {
        toast.warning(
          res.raggedRows === 1
            ? "1 row didn't match the header's column count and was padded or trimmed."
            : `${res.raggedRows} rows didn't match the header's column count and were padded or trimmed.`,
        );
      }
      if (res.truncated) {
        toast.warning("The file has more rows than a test can hold — the rest were dropped.");
      }
    },
    onError: (err: unknown) => toast.error(String(err)),
  });

  // ── Reusable flow ─────────────────────────────────────────────────
  const flowParams = React.useMemo(() => test.flowParams ?? [], [test.flowParams]);
  const setFlowState = useMutation({
    mutationFn: (p: { isFlow: boolean; params: string[] }) =>
      api.tests.setFlow(test.id, p.isFlow, p.params),
    onSuccess: invalidate,
    onError: (err: unknown) => toast.error(String(err)),
  });
  // Secrets are never offered as parameters: an argument is stored as plain
  // text on the CALLING test's record, so parameterizing a secret would route
  // its value around the encrypted store. Same rule as dataset columns above.
  const paramCandidates = React.useMemo(() => {
    const seen = new Set<string>();
    return variables.filter((v) => {
      if (v.kind === "secret" || !isValidName(v.name) || seen.has(v.name)) return false;
      seen.add(v.name);
      return true;
    });
  }, [variables]);
  // Declared parameters no longer backed by an offerable variable — a renamed
  // or deleted variable, or one since made secret. Callers can still bind
  // them (the generator falls back to ""), but they are probably stale.
  const orphanParams = React.useMemo(
    () => flowParams.filter((p) => !paramCandidates.some((v) => v.name === p)),
    [flowParams, paramCandidates],
  );
  const toggleParam = (name: string, on: boolean) => {
    const next = on ? [...flowParams, name] : flowParams.filter((p) => p !== name);
    setFlowState.mutate({ isFlow: true, params: next });
  };

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
                applyVariables([...variables, { name: "", kind: "plain", value: "" }])
              }
            >
              <Plus className="size-4" />
              Add variable
            </Button>
          </div>
          <Text size="small" className="text-secondary">
            Reference a variable from any step value with{" "}
            <code className="font-mono">{"${name}"}</code> — or pick one from the trainer, where
            the training browser&apos;s right-click menu offers <em>Use variable…</em> on the field
            you are filling.
          </Text>

          {/* Stated here rather than only on the row that has it, because the
              decision this warns about is made BEFORE any row exists: "Value"
              is the default kind, and a password typed into one is on disk in
              two places (the record, and the generated spec) before there is
              anything to warn about. Secrets are the exception, so the notice
              says which is which rather than just "be careful". */}
          <Callout color="yellow" icon={<TriangleAlert className="size-4" />}>
            <Callout.Text>
              <strong>Value</strong> and <strong>Captured</strong> variables — and every dataset row
              below — are stored as <strong>plain text</strong>, in this test&apos;s record on disk
              and in the generated spec. Only a <strong>Secret</strong> is encrypted, kept out of
              the spec, and stripped from run logs and anything sent to a hosted model. Use one for
              a password.
            </Callout.Text>
          </Callout>

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
                  duplicate={duplicateAt[i]}
                  onChange={(next) => {
                    const copy = [...variables];
                    copy[i] = next;
                    applyVariables(copy);
                  }}
                  onRemove={() => applyVariables(variables.filter((_, j) => j !== i))}
                  onSetSecret={(value) => setSecret.mutate({ name: v.name, value })}
                  onClearSecret={() => clearSecret.mutate(v.name)}
                />
              ))}
            </div>
          )}
        </section>

        {/* ── Reusable flow ─────────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Workflow className="size-4 text-secondary" />
            <Text weight="medium">Reusable flow</Text>
            <div className="flex-1" />
            <Switch
              checked={!!test.isFlow}
              onCheckedChange={(on) => setFlowState.mutate({ isFlow: on, params: flowParams })}
              aria-label="Reusable flow"
            />
          </div>
          {test.isFlow ? (
            <>
              <Text size="small" className="text-secondary">
                Other tests can insert this test&apos;s steps with a <em>Run flow</em> step from the
                trainer&apos;s Add-step menu. Tick the variables a caller may override; an argument
                left blank falls back to the variable&apos;s value here.
              </Text>
              {paramCandidates.length === 0 ? (
                <Text size="small" className="text-tertiary">
                  No variables to offer as parameters yet — declare one above to make this flow
                  configurable.
                </Text>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {paramCandidates.map((v) => (
                    <label key={v.name} className="flex cursor-pointer items-center gap-2">
                      <Checkbox
                        checked={flowParams.includes(v.name)}
                        onCheckedChange={(on: boolean | "indeterminate") =>
                          toggleParam(v.name, on === true)
                        }
                        aria-label={`Parameter ${v.name}`}
                      />
                      <Text size="small" className="font-mono">
                        {v.name}
                      </Text>
                      {v.value ? (
                        <Text size="small" className="truncate text-tertiary">
                          default: {v.value}
                        </Text>
                      ) : null}
                    </label>
                  ))}
                </div>
              )}
              {orphanParams.length > 0 ? (
                <Callout color="yellow" icon={<TriangleAlert className="size-4" />}>
                  <Callout.Text>
                    Parameters with no matching variable — callers that bind them still work, but
                    an argument left blank falls back to empty:{" "}
                    {orphanParams.map((p) => (
                      <Button
                        key={p}
                        size="small"
                        variant="muted"
                        className="mx-0.5"
                        onClick={() => toggleParam(p, false)}
                        aria-label={`Remove parameter ${p}`}
                      >
                        {p} ×
                      </Button>
                    ))}
                  </Callout.Text>
                </Callout>
              ) : null}
            </>
          ) : (
            <Text size="small" className="text-tertiary">
              Off — this test is not offered in the trainer&apos;s Add-step flow list.
            </Text>
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
              disabled={importCsv.isPending}
              onClick={() => importCsv.mutate()}
            >
              <FileUp className="size-4" />
              Import CSV…
            </Button>
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
            failure points at a row rather than looking like flake. Row values are stored as plain
            text — a row cannot supply a secret, and one naming a secret variable is ignored at run
            time rather than allowed to substitute a plaintext value for the encrypted one.
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
