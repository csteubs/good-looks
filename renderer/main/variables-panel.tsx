// Variables, reuse & identity, and datasets — a test's Variables tab.
//
// ── What a variable IS ───────────────────────────────────────────────
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
// All four share ONE NAMESPACE — a `${name}` reference does not care where the
// value came from — so a name declared twice is a mistake whichever kinds are
// involved. That is why `duplicateAt` below is computed over the whole list in
// its stored order, and why the offending row renders its error wherever it
// sits. The list is *drawn* in four groups (see below); it is not four lists.
//
// ── Why the kinds are drawn as separate groups ───────────────────────
//
// The kind decides what may be DONE to a variable: a secret's value can only be
// replaced, a generated one has no value at all, and a dataset row may never
// carry either. Drawn as one flat list with a kind dropdown on every row, the
// commonest action (edit a value) and the rarest (change what a variable IS)
// sat in adjacent columns at equal weight, one mis-click apart — and every
// section of the tab put its own control at the far right edge of the window,
// so nothing tied a control to the thing it acted on.
//
// So: one `Panel` per concern with its control in its own header, and inside
// the Variables panel one group per kind, each stating its own storage rule and
// offering exactly ONE value affordance. Changing a kind moved to the row's
// menu, where a rare and consequential action belongs.
//
// ── When this tab is allowed to use colour ───────────────────────────
//
// Only for something the user must act on, and in two tiers:
//
//   blocking (red)  the row will not save — an invalid or duplicated name. The
//                   draft is held locally until it is fixed.
//   action (amber)  it saved, and a run will still go ahead wrong — a secret
//                   with no stored value that steps already read, or basic auth
//                   pointing at a secret that is gone.
//
// Everything merely TRUE is body copy: that values are plain text, that a
// session is stale, that a flow parameter no longer matches a variable. The
// standing amber callout this replaced was on screen permanently and asked for
// nothing, which is how an interface teaches the eye to skip its own warnings.
//
// Datasets are rows over the plain/captured variables. Running a sweep queues
// the test once per row, so a failure can be attributed to a specific row
// rather than showing up as flake.

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuTrigger,
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
import { Ellipsis, FileUp, Play, Plus, Trash2, TriangleAlert } from "lucide-react";

import { Btn, Panel, Segmented } from "../theme";
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

/** The order the groups are drawn in, and the plural legend each takes.
 *
 *  Deliberately not `VARIABLE_KINDS` order-by-accident: the list reads
 *  strongest → weakest guarantee, so the encrypted kind sits directly under the
 *  plaintext one it is the alternative to. */
const GROUP_ORDER: VariableKind[] = ["plain", "secret", "captured", "generated"];

const GROUP_TITLE: Record<VariableKind, string> = {
  plain: "Values",
  secret: "Secrets",
  captured: "Captured",
  generated: "Generated",
};

/** Each group's storage rule, stated where its kind is chosen.
 *
 *  This is what the standing amber callout became. The old notice said all of
 *  it at once, above the whole list, permanently — so it was on screen for
 *  someone editing a generated variable, to whom none of it applied. Split per
 *  kind it is shorter, always relevant, and read at the moment it matters. */
const GROUP_NOTE: Record<VariableKind, string> = {
  plain: "Plain text, in this test's record on disk and in the generated spec.",
  secret:
    "Encrypted on this Mac. Never written into the spec, never in a run log, and never sent to a hosted model. A stored value is never shown again — only replaced or cleared.",
  captured:
    "Written during the run by a capture step. A value here is only a fallback for steps that read it first, and is stored as plain text.",
  generated:
    "A fresh value every run; the run log records what was used. A dataset row naming one pins it instead.",
};

/* ── Small shared pieces ─────────────────────────────────────────────── */

/** A hairline group inside a `Panel` — legend, its rule as body copy, one
 *  control slot, and a body.
 *
 *  Local rather than a `renderer/theme/primitives/` export on purpose: seven
 *  uses on one screen makes it a component, not yet a vocabulary. Promote it
 *  when a second screen wants the same box. */
function GroupBox({
  title,
  note,
  right,
  children,
}: {
  title: string;
  note?: React.ReactNode;
  right?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="gl-var-group" aria-label={title}>
      <div className="gl-var-group-head">
        <span className="gl-var-group-title">{title}</span>
        {note ? <span className="gl-var-group-note">{note}</span> : null}
        {right ? <span className="gl-var-group-right">{right}</span> : null}
      </div>
      {children ? <div className="gl-var-group-body">{children}</div> : null}
    </section>
  );
}

/** The one thing on this tab allowed to be coloured — see the header. `tier`
 *  is not a style choice: `blocking` means the list will not round-trip until
 *  it is fixed, `action` means it saved and the next run will be wrong. */
function Flag({
  tier,
  children,
}: {
  tier: "blocking" | "action";
  children: React.ReactNode;
}) {
  // No `role="status"`. A blocking flag appears while the user is still typing
  // the name, and a live region there announces on every keystroke; the text is
  // visible and sits directly under the field it is about.
  return (
    <div className={`gl-var-flag gl-var-flag-${tier}`} data-tier={tier}>
      <TriangleAlert aria-hidden />
      <span>{children}</span>
    </div>
  );
}

/** Ordinary explanation. `as="p"` rather than the default span: these are
 *  sentences, and a paragraph is what a screen reader (and every test that
 *  looks for the notice) can address as one. */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <Text as="p" className="gl-var-note">
      {children}
    </Text>
  );
}

/* ── One variable ────────────────────────────────────────────────────── */

/** The value column, which is the ONLY thing that differs between groups. Each
 *  kind gets exactly one affordance, so inside a group there is only one thing
 *  a control can mean. */
function ValueCell({
  variable,
  hasSecret,
  onChange,
  onSetSecret,
  onClearSecret,
}: {
  variable: TestVariable;
  hasSecret: boolean;
  onChange: (next: TestVariable) => void;
  onSetSecret: (value: string) => void;
  onClearSecret: () => void;
}) {
  const [secretDraft, setSecretDraft] = React.useState("");
  const nameOk = isValidName(variable.name);

  if (variable.kind === "secret") {
    return (
      <div className="gl-var-cell">
        {hasSecret ? (
          <>
            <span className="gl-chip">value stored</span>
            <Text size="small" className="text-tertiary">
              A value is stored, encrypted on this Mac.
            </Text>
            <Btn onClick={onClearSecret}>Clear</Btn>
          </>
        ) : (
          <>
            <Input
              aria-label={`Value for ${variable.name}`}
              type="password"
              value={secretDraft}
              placeholder="Value (stored encrypted)"
              className="min-w-0 flex-1 font-mono"
              onChange={(e) => setSecretDraft(e.target.value)}
            />
            <Btn
              disabled={!secretDraft || !nameOk}
              onClick={() => {
                onSetSecret(secretDraft);
                setSecretDraft("");
              }}
            >
              Save
            </Btn>
          </>
        )}
        {/* Replaces a checkbox and the three-line paragraph beside it. A secret
            is one of two things and never both, which is a segmented control's
            exact shape — and it reuses the control the rest of the app already
            spells an exclusive choice with. */}
        <Segmented
          label={`What ${variable.name || "this secret"} holds`}
          value={variable.totp ? "totp" : "password"}
          onChange={(v) => onChange({ ...variable, totp: v === "totp" })}
          options={[
            { value: "password", label: "Password", title: "Used verbatim." },
            {
              value: "totp",
              label: "TOTP key",
              title:
                "Store the base32 setup key from MFA setup, not a one-time code — steps type the CURRENT 6-digit code, derived at each read.",
            },
          ]}
        />
      </div>
    );
  }

  if (variable.kind === "generated") {
    return (
      <div className="gl-var-cell">
        <Select
          value={variable.genSpec ?? "string"}
          onValueChange={(v) => onChange({ ...variable, genSpec: v as GenSpec })}
        >
          <SelectTrigger
            aria-label={`Generator for ${variable.name || "variable"}`}
            className="w-64"
          >
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
      </div>
    );
  }

  return (
    <Input
      aria-label={`Default value for ${variable.name || "variable"}`}
      value={variable.value ?? ""}
      className="font-mono"
      placeholder={
        variable.kind === "captured" ? "Fallback before the capture runs (optional)" : "Value"
      }
      onChange={(e) => onChange({ ...variable, value: e.target.value })}
    />
  );
}

function VariableRow({
  variable,
  hasSecret,
  usedBy,
  duplicate,
  onChange,
  onChangeKind,
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
  onChangeKind: (kind: VariableKind) => void;
  onRemove: () => void;
  onSetSecret: (value: string) => void;
  onClearSecret: () => void;
}) {
  const nameOk = isValidName(variable.name);
  const label = variable.name || "variable";
  // A declared secret with nothing behind it is only worth interrupting for
  // once something READS it: that is the case where the next run goes ahead and
  // silently sends an empty string. A secret just declared and not yet filled
  // in has its own input on screen and needs no warning about it.
  const emptySecretInUse = variable.kind === "secret" && !hasSecret && usedBy > 0;

  return (
    <div className="gl-var-entry">
      <div className="gl-var-row">
        <Input
          aria-label="Variable name"
          value={variable.name}
          placeholder="name"
          className="font-mono"
          onChange={(e) => onChange({ ...variable, name: e.target.value })}
        />
        <ValueCell
          variable={variable}
          hasSecret={hasSecret}
          onChange={onChange}
          onSetSecret={onSetSecret}
          onClearSecret={onClearSecret}
        />
        {usedBy > 0 ? (
          <span className="gl-chip">
            used by {usedBy} step{usedBy === 1 ? "" : "s"}
          </span>
        ) : (
          <span />
        )}
        {/* ONE control for the row's two rare actions. A trash icon beside a
            kind dropdown put "delete a variable four steps depend on" and
            "change what this variable IS" at the same weight as editing its
            value; both now cost a deliberate second gesture. Native-menu
            backed, so its items never enter the DOM — tests drive it by
            stubbing `glazeAPI.Menu.popup`, the same way every Select here is
            covered. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="gl-icon-btn" aria-label={`Actions for ${label}`}>
              <Ellipsis aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuSub label="Change type">
              {VARIABLE_KINDS.filter((k) => k !== variable.kind).map((k) => (
                <DropdownMenuItem key={k} onSelect={() => onChangeKind(k)}>
                  {VARIABLE_KIND_LABELS[k]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onRemove}>{`Remove ${label}`}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {!nameOk && variable.name !== "" ? (
        <Flag tier="blocking">
          Use letters, numbers and underscores, starting with a letter — the name becomes a
          property in the generated spec. Not saved until it is fixed.
        </Flag>
      ) : null}

      {nameOk && duplicate ? (
        <Flag tier="blocking">
          Already declared above — rename this one, or it won&apos;t be saved.
        </Flag>
      ) : null}

      {emptySecretInUse ? (
        <Flag tier="action">
          No value stored — the {usedBy} step{usedBy === 1 ? "" : "s"} that read{" "}
          <code className="font-mono">{"${" + variable.name + "}"}</code> will send an empty
          string.
        </Flag>
      ) : null}
    </div>
  );
}

/* ── The tab ─────────────────────────────────────────────────────────── */

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
  // HTTP basic auth draft — same latch. The password itself is never state
  // here: `authVar` NAMES a secret variable, and that is all the record holds.
  const [authUser, setAuthUser] = React.useState(test.basicAuth?.username ?? "");
  const [authVar, setAuthVar] = React.useState(test.basicAuth?.passwordVar ?? "");
  const [seededFor, setSeededFor] = React.useState(test.id);
  if (seededFor !== test.id) {
    setSeededFor(test.id);
    setVars(test.variables ?? []);
    setAuthUser(test.basicAuth?.username ?? "");
    setAuthVar(test.basicAuth?.passwordVar ?? "");
  }
  const variables = vars;
  const datasets = React.useMemo(() => test.datasets ?? [], [test.datasets]);

  // Names an EARLIER row already claims. The normalizer keeps the first of a
  // duplicate pair, so a list containing one wouldn't round-trip losslessly.
  // Computed over the WHOLE list in stored order, not per group: the four kinds
  // share one namespace, so a plain `email` and a secret `email` collide.
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
  // What the basic-auth picker below may reference: declared secrets with
  // usable names. The backend re-gates the name (normalizeBasicAuth), so this
  // is a UI courtesy, not the boundary.
  const authSecretNames = React.useMemo(
    () => variables.filter((v) => v.kind === "secret" && isValidName(v.name)).map((v) => v.name),
    [variables],
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
    // The origins query reads the STEPS, which a rewrite changes without
    // changing their count — so nothing else here would refetch it, and the
    // "this test points at …" offer would stay on screen after it had been
    // taken. Found by pressing the button in the preview and watching it
    // survive its own success.
    void qc.invalidateQueries({ queryKey: ["originsIn", test.id] });
    // The secret-status query backs the basic-auth "no stored value" warning.
    // tests:setVariables clears the encrypted value of a dropped secret, so a
    // delete-and-redeclare would otherwise leave a stale "has a value" cache
    // and hide the warning while the password is actually gone.
    void qc.invalidateQueries({ queryKey: ["secretStatus", test.id] });
  };

  const saveVariables = useMutation({
    mutationFn: (next: TestVariable[]) => api.tests.setVariables(test.id, next),
    onSuccess: invalidate,
    onError: (err: unknown) => toast.error(String(err)),
  });

  // Which site addresses this test's steps still point at LITERALLY. Read from
  // the backend rather than recomputed here: the rule for "a URL on this
  // origin" is a boundary rule (it decides what gets rewritten into generated
  // source), and a second copy of it in the renderer is how the button comes to
  // offer an origin the backend then refuses.
  const origins = useQuery({
    queryKey: ["originsIn", test.id],
    queryFn: () => api.tests.originsIn(test.id),
  });
  const topOrigin = (origins.data ?? [])[0];

  const parameterise = useMutation({
    mutationFn: (origin: string) => api.tests.parameteriseOrigin(test.id, origin),
    onSuccess: (result) => {
      invalidate();
      setVars(result.test.variables ?? []);
      toast.success(
        `${result.rewritten} ${result.rewritten === 1 ? "place" : "places"} now use ` +
          "${" + result.name + "}" +
          (result.reusedVariable ? " (existing variable reused)." : "."),
      );
    },
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

  const addVariable = (kind: VariableKind) =>
    applyVariables([
      ...variables,
      kind === "generated"
        ? { name: "", kind, genSpec: "string" as GenSpec }
        : kind === "secret"
          ? { name: "", kind }
          : { name: "", kind, value: "" },
    ]);

  /** Change what a variable IS.
   *
   *  The fields a kind may not carry are dropped HERE as well as on write.
   *  `normalizeVariables` already refuses to store a secret's or a generated
   *  variable's `value`, so the record is safe either way — but leaving the old
   *  plaintext in the local draft would keep it on screen under a legend
   *  promising it is encrypted, which is the worst possible half-second. */
  const changeKind = (index: number, kind: VariableKind) => {
    const current = variables[index];
    const next: TestVariable = { name: current.name, kind };
    if (kind === "plain" || kind === "captured") next.value = current.value ?? "";
    if (kind === "generated") next.genSpec = current.genSpec ?? "string";
    if (kind === "secret" && current.totp) next.totp = true;
    const copy = [...variables];
    copy[index] = next;
    applyVariables(copy);
  };

  const saveDatasets = useMutation({
    mutationFn: (next: Dataset[]) => api.tests.setDatasets(test.id, next),
    onSuccess: invalidate,
    onError: (err: unknown) => toast.error(String(err)),
  });

  const saveAuth = useMutation({
    mutationFn: () =>
      api.tests.setBasicAuth(test.id, { username: authUser, passwordVar: authVar }),
    onSuccess: () => {
      toast.success("Basic auth saved — the trainer and every run will answer the prompt");
      invalidate();
    },
    onError: (err: unknown) => toast.error(String(err)),
  });
  const clearAuth = useMutation({
    mutationFn: () => api.tests.setBasicAuth(test.id, null),
    onSuccess: () => {
      setAuthUser("");
      setAuthVar("");
      toast.success("Basic auth cleared");
      invalidate();
    },
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

  // ── Login session ─────────────────────────────────────────────────
  const sessionInfo = useQuery({
    queryKey: ["sessionState", test.id],
    queryFn: () => api.tests.sessionState(test.id),
  });
  const allTests = useQuery({ queryKey: ["tests"], queryFn: () => api.tests.list() });
  const setSession = useMutation({
    mutationFn: (patch: { saveSession?: boolean; useSessionFrom?: string | null }) =>
      api.tests.setSession(test.id, patch),
    onSuccess: invalidate,
    onError: (err: unknown) => toast.error(String(err)),
  });
  const clearSession = useMutation({
    mutationFn: () => api.tests.clearSessionState(test.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["sessionState", test.id] }),
    onError: (err: unknown) => toast.error(String(err)),
  });
  /** Tests whose sessions can be started from: they save one, and are not
   *  this test. */
  const sessionSources = React.useMemo(
    () => (allTests.data ?? []).filter((t) => t.saveSession && t.id !== test.id),
    [allTests.data, test.id],
  );

  const runSweep = useMutation({
    mutationFn: () => api.batch.run([test.id], { allDatasets: true }),
    onSuccess: () => toast.success("Sweep started — watch it in the Routines view"),
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
  // its value around the encrypted store. Same rule as dataset columns below.
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

  // Only plain/captured/generated variables get dataset columns: a secret's
  // value comes from the encrypted store, and a row that could override it
  // would put a plaintext credential straight back into tests.json.
  const columns = variables.filter((v) => v.kind !== "secret").map((v) => v.name);

  const secretCount = variables.filter((v) => v.kind === "secret").length;

  /** Each kind's rows, carrying the index into the STORED list — every edit
   *  writes back through that index, so grouping changes what is drawn and
   *  never what is saved. */
  const grouped = React.useMemo(() => {
    const out = new Map<VariableKind, { variable: TestVariable; index: number }[]>();
    for (const kind of GROUP_ORDER) out.set(kind, []);
    variables.forEach((variable, index) => {
      out.get(variable.kind)?.push({ variable, index });
    });
    return out;
  }, [variables]);

  const editVariable = (index: number, next: TestVariable) => {
    const copy = [...variables];
    copy[index] = next;
    applyVariables(copy);
  };

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 p-3">
        {/* ── Variables ─────────────────────────────────────────────── */}
        <Panel
          title="Variables"
          id={
            variables.length === 0
              ? "None declared"
              : `${variables.length} declared${secretCount > 0 ? ` · ${secretCount} secret` : ""}`
          }
          right={
            /* The one place a kind is CHOSEN rather than changed, and the only
               affordance when the list is empty and no group is drawn yet. */
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Btn aria-label="Add variable">
                  <Plus aria-hidden />
                  Add variable
                </Btn>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {GROUP_ORDER.map((kind) => (
                  <DropdownMenuItem key={kind} onSelect={() => addVariable(kind)}>
                    {VARIABLE_KIND_LABELS[kind]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          }
          pad={10}
        >
          <div className="flex flex-col gap-2.5">
            <Note>
              Reference a variable from any step value with{" "}
              <code className="font-mono">{"${name}"}</code> — or pick one from the trainer, where
              the training browser&apos;s right-click menu offers <em>Use variable…</em> on the
              field you are filling. All four kinds share one namespace, so a name may be declared
              only once.
            </Note>
            {/* Kept out of the group legends because it is the comparison
                between kinds, made before any kind has been chosen — and
                because it is the sentence someone reaches for when deciding
                where a password goes. Body copy, not a callout: it is always
                true, and nothing about it needs doing. */}
            <Note>
              <strong>Value</strong> and <strong>Captured</strong> variables — and every dataset
              row below — are stored as <strong>plain text</strong>, in this test&apos;s record on
              disk and in the generated spec. Only a <strong>Secret</strong> is encrypted, kept out
              of the spec, and stripped from run logs and anything sent to a hosted model. Use one
              for a password.
            </Note>

            {/* ── Re-point the whole test ──────────────────────────────
                A recorded test navigates to the ABSOLUTE address it was recorded
                against, so Playwright's own baseURL cannot move it — verified
                against the real CLI. What does move it is this: declare the
                address as a variable, and every URL on it follows. The default
                keeps a plain run identical, so the button is safe to press. */}
            {topOrigin && !test.scriptEdited ? (
              <div className="gl-var-offer">
                <Note>
                  This test points at <code className="font-mono">{topOrigin.origin}</code> in{" "}
                  {topOrigin.count} {topOrigin.count === 1 ? "place" : "places"}. Make it a
                  variable to run the same test against staging or a preview build.
                </Note>
                <Btn disabled={parameterise.isPending} onClick={() => parameterise.mutate(topOrigin.origin)}>
                  Use a variable for the site address
                </Btn>
              </div>
            ) : null}

            {variables.length === 0 ? (
              <Note>
                No variables yet. Add one to reuse a value across steps, keep a password out of
                the generated spec, or run this test over several rows of data.
              </Note>
            ) : (
              /* Only the kinds in use are drawn. Four empty boxes above a test
                 with one variable would be a legend of the type system rather
                 than a list of this test's variables — and the header's menu is
                 how an unused kind is reached. */
              GROUP_ORDER.filter((kind) => (grouped.get(kind) ?? []).length > 0).map((kind) => (
                <GroupBox
                  key={kind}
                  title={GROUP_TITLE[kind]}
                  note={GROUP_NOTE[kind]}
                  right={
                    <button
                      type="button"
                      className="gl-icon-btn"
                      aria-label={`Add to ${GROUP_TITLE[kind]}`}
                      onClick={() => addVariable(kind)}
                    >
                      <Plus aria-hidden />
                    </button>
                  }
                >
                  {(grouped.get(kind) ?? []).map(({ variable, index }) => (
                    <VariableRow
                      key={index}
                      variable={variable}
                      hasSecret={storedSecrets.has(variable.name)}
                      usedBy={usage.get(variable.name) ?? 0}
                      duplicate={duplicateAt[index]}
                      onChange={(next) => editVariable(index, next)}
                      onChangeKind={(next) => changeKind(index, next)}
                      onRemove={() => applyVariables(variables.filter((_, j) => j !== index))}
                      onSetSecret={(value) => setSecret.mutate({ name: variable.name, value })}
                      onClearSecret={() => clearSecret.mutate(variable.name)}
                    />
                  ))}
                </GroupBox>
              ))
            )}
          </div>
        </Panel>

        {/* ── Reuse & identity ──────────────────────────────────────────
            Three things that are not variables but are decided here, gathered
            under one heading rather than left as three unlabelled stretches of
            the same scroll. Basic auth in particular BELONGS beside the list:
            its password is a Secret variable by construction — the record
            stores only its NAME, so the value follows the one encrypted path
            that already exists (test-secrets-store → env → redaction) instead
            of growing a second credential store. The trainer answers the
            browser's credential prompt with the same values the run's
            `test.use({ httpCredentials })` reads, so a wall that blocks one
            blocks neither. */}
        <Panel title="Reuse & identity" id="How this test is shared, and how it signs in" pad={10}>
          <div className="flex flex-col gap-2.5">
            <GroupBox
              title="Reusable flow"
              note={
                test.isFlow
                  ? "Other tests can insert these steps with a Run flow step from the trainer's Add-step menu. Tick the variables a caller may override; an argument left blank falls back to the value here."
                  : "Off — this test is not offered in the trainer's Add-step flow list."
              }
              right={
                <Switch
                  checked={!!test.isFlow}
                  onCheckedChange={(on) => setFlowState.mutate({ isFlow: on, params: flowParams })}
                  aria-label="Reusable flow"
                />
              }
            >
              {test.isFlow ? (
                <div className="gl-var-params">
                  {paramCandidates.length === 0 ? (
                    <Note>
                      No variables to offer as parameters yet — declare one above to make this
                      flow configurable.
                    </Note>
                  ) : (
                    paramCandidates.map((v) => (
                      <label key={v.name} className="gl-var-param">
                        <Checkbox
                          checked={flowParams.includes(v.name)}
                          onCheckedChange={(on: boolean | "indeterminate") =>
                            toggleParam(v.name, on === true)
                          }
                          aria-label={`Parameter ${v.name}`}
                        />
                        <span className="gl-var-param-name">{v.name}</span>
                        {v.value ? (
                          <span className="gl-var-param-default">default: {v.value}</span>
                        ) : null}
                      </label>
                    ))
                  )}
                  {/* Advisory, not actionable: a caller that already binds one
                      of these keeps working, and the generator falls back to
                      "". It was an amber callout, which put it at the same
                      weight as a credential that is about to be sent empty. */}
                  {orphanParams.length > 0 ? (
                    <div className="gl-var-offer">
                      <Note>
                        Parameters with no matching variable — callers that bind them still work,
                        but an argument left blank falls back to empty.
                      </Note>
                      <span className="flex flex-wrap gap-1">
                        {orphanParams.map((p) => (
                          <Btn
                            key={p}
                            onClick={() => toggleParam(p, false)}
                            aria-label={`Remove parameter ${p}`}
                          >
                            {p} ×
                          </Btn>
                        ))}
                      </span>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </GroupBox>

            <GroupBox
              title="Login session"
              note="Saves this test's signed-in state after a PASSING run, so other tests can start from it instead of logging in again. A failed run never saves."
              right={
                <Switch
                  checked={!!test.saveSession}
                  onCheckedChange={(v: boolean) => setSession.mutate({ saveSession: v })}
                  aria-label="Save signed-in state after passing runs"
                />
              }
            >
              <div className="flex flex-col gap-2 py-1.5">
                {test.saveSession ? (
                  <div className="gl-var-offer">
                    <Note>
                      {sessionInfo.data
                        ? sessionInfo.data.fresh
                          ? "A signed-in state is saved and fresh."
                          : "A state is saved but STALE — runs ignore it until this test passes again."
                        : "No state saved yet — run this test (and pass) to save one."}
                    </Note>
                    {sessionInfo.data ? (
                      <Btn onClick={() => clearSession.mutate()}>Clear saved state</Btn>
                    ) : null}
                  </div>
                ) : null}
                <div className="gl-var-offer">
                  <Note>
                    Start runs from the saved session of another test. Only tests that save one
                    are offered; a stale or missing state is reported in the run output and the
                    run proceeds signed out, never failing the run by itself.
                  </Note>
                  <Select
                    value={test.useSessionFrom ?? "none"}
                    onValueChange={(v) =>
                      setSession.mutate({ useSessionFrom: v === "none" ? null : v })
                    }
                  >
                    <SelectTrigger aria-label="Session source" className="w-96">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None — start signed out</SelectItem>
                      {sessionSources.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </GroupBox>

            <GroupBox
              title="HTTP basic auth"
              note="For a site behind a browser password prompt. The training browser and every run answer the prompt with these credentials. The password is a Secret variable, so it stays encrypted, out of the generated spec, and out of run logs."
            >
              <div className="flex flex-col gap-2 py-1.5">
                {authSecretNames.length === 0 ? (
                  <Note>
                    Declare a <strong>Secret</strong> variable above to hold the password, then
                    choose it here.
                  </Note>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        className="w-56 font-mono"
                        value={authUser}
                        onChange={(e) => setAuthUser(e.target.value)}
                        placeholder="username"
                        aria-label="Basic auth username"
                      />
                      <Select value={authVar || undefined} onValueChange={setAuthVar}>
                        <SelectTrigger
                          aria-label="Secret variable holding the basic auth password"
                          className="w-56"
                        >
                          <SelectValue placeholder="Choose a secret…" />
                        </SelectTrigger>
                        <SelectContent>
                          {authSecretNames.map((name) => (
                            <SelectItem key={name} value={name}>
                              {name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Btn
                        disabled={!authVar || saveAuth.isPending}
                        onClick={() => saveAuth.mutate()}
                        aria-label="Save basic auth"
                      >
                        Save
                      </Btn>
                      {test.basicAuth ? (
                        <Btn
                          disabled={clearAuth.isPending}
                          onClick={() => clearAuth.mutate()}
                          aria-label="Clear basic auth"
                        >
                          Clear
                        </Btn>
                      ) : null}
                    </div>
                    {authVar && !storedSecrets.has(authVar) && authSecretNames.includes(authVar) ? (
                      <Flag tier="action">
                        The secret <code className="font-mono">{authVar}</code> has no stored value
                        yet — set one above, or the prompt will be answered with an empty password.
                      </Flag>
                    ) : null}
                    {authVar && !authSecretNames.includes(authVar) ? (
                      <Flag tier="action">
                        No secret variable named <code className="font-mono">{authVar}</code> is
                        declared any more — the prompt will be answered with an empty password
                        until this points at one.
                      </Flag>
                    ) : null}
                  </>
                )}
              </div>
            </GroupBox>
          </div>
        </Panel>

        {/* ── Datasets ──────────────────────────────────────────────── */}
        <Panel
          title="Datasets"
          id={
            datasets.length === 0
              ? "No rows"
              : `${datasets.length} row${datasets.length === 1 ? "" : "s"} · ${columns.length} column${
                  columns.length === 1 ? "" : "s"
                }`
          }
          right={
            <>
              <Btn disabled={importCsv.isPending} onClick={() => importCsv.mutate()}>
                <FileUp aria-hidden />
                Import CSV…
              </Btn>
              <Btn
                disabled={columns.length === 0}
                onClick={() =>
                  saveDatasets.mutate([
                    ...datasets,
                    { id: newRowId(), name: `Row ${datasets.length + 1}`, values: {} },
                  ])
                }
              >
                <Plus aria-hidden />
                Add row
              </Btn>
              <Btn
                tone="go"
                disabled={datasets.length === 0 || runSweep.isPending}
                onClick={() => runSweep.mutate()}
              >
                <Play aria-hidden />
                Run sweep
              </Btn>
            </>
          }
          pad={10}
        >
          <div className="flex flex-col gap-2.5">
            <Note>
              Each row runs the test once with its own values, and is recorded as its own run — so
              a failure points at a row rather than looking like flake. Row values are stored as
              plain text — a row cannot supply a secret, and one naming a secret variable is
              ignored at run time rather than allowed to substitute a plaintext value for the
              encrypted one.
            </Note>

            {columns.length === 0 ? (
              <Note>Add a variable first — rows supply values for the variables this test declares.</Note>
            ) : datasets.length === 0 ? (
              <Note>No rows yet.</Note>
            ) : (
              /* A TABLE, not a card per row. Every row holds the same variables
                 in the same order, and the question the section exists to
                 answer — what is `email` on each row — is a column. As a stack
                 of cards with a wrapping field cluster in each, it could only be
                 answered by reading every card and holding them in your head. */
              <div className="gl-var-table-scroll">
                <table className="gl-var-table">
                  <thead>
                    <tr>
                      <th className="gl-var-table-name">Row</th>
                      {columns.map((name) => (
                        <th key={name} className="gl-var-table-value">
                          {name}
                        </th>
                      ))}
                      <th className="gl-var-table-actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {datasets.map((row, i) => (
                      <tr key={row.id}>
                        <td className="gl-var-table-name">
                          <Input
                            aria-label={`Name for row ${i + 1}`}
                            value={row.name}
                            placeholder="Row name"
                            onChange={(e) => {
                              const copy = [...datasets];
                              copy[i] = { ...row, name: e.target.value };
                              saveDatasets.mutate(copy);
                            }}
                          />
                        </td>
                        {columns.map((name) => (
                          <td key={name} className="gl-var-table-value">
                            <Input
                              aria-label={`${name} for row ${row.name}`}
                              className="font-mono"
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
                          </td>
                        ))}
                        <td className="gl-var-table-actions">
                          {/* A trash icon rather than the variable row's menu:
                              a dataset row has exactly one action, and a menu
                              holding one item is friction with nothing behind
                              it. The variable row's menu exists because there
                              are two. */}
                          <button
                            type="button"
                            className="gl-icon-btn"
                            aria-label={`Remove row ${row.name}`}
                            onClick={() =>
                              saveDatasets.mutate(datasets.filter((_, j) => j !== i))
                            }
                          >
                            <Trash2 aria-hidden />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Panel>
      </div>
    </ScrollArea>
  );
}
