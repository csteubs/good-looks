// Choosing a variable, and declaring one, from wherever a step is being built.
//
// Three surfaces need this and none of them can reach the Variables tab: the
// docked trainer panel, the trainer in the main window, and the Edit Steps
// editor. Before this existed, `${name}` was the whole interface — a syntax
// with no affordance, which meant the feature was reachable only by someone who
// had read the generator.
//
// CHIPS RATHER THAN A SELECT, and that is a testing decision as much as a
// design one. This repo's `Select` is backed by a real macOS menu, so its
// options never enter the DOM and no Testing Library query can reach them (see
// CLAUDE.md). A picker whose every path is untestable is the wrong control for
// the one place a wrong pick means a password in a spec file.
//
// The plaintext warning is stated at the point of entry rather than only on the
// Variables tab, because this is where a password gets typed for the first
// time: a "Value" variable's default is stored verbatim in the test record and
// baked into the generated spec, and the only thing that keeps it out of both
// is choosing Secret BEFORE typing.

import * as React from "react";
import { Badge, Button, Callout, Field, Input, SegmentedControl, SegmentedControlItem, Text } from "@ui";
import { KeyRound, Plus, TriangleAlert, Variable } from "lucide-react";

import { GEN_SPECS, type GenSpec, type TestVariable, type VariableKind } from "../lib/recorder-types";

/** How a variable is spelled inside a step value. The ONE place the renderer
 *  writes this form — the generator's matcher is the authority on reading it
 *  (`VAR_REF_RE` in script-generator.ts), and two spellings of the same
 *  reference is how a step comes to interpolate nothing. */
export function varRef(name: string): string {
  return "${" + name + "}";
}

/** Splice a reference into a draft at the caret.
 *
 *  A caret rather than an append because the useful edit is usually a
 *  SUBSTITUTION inside existing text — `${user}@example.com`, `Order ${id}` —
 *  and appending would make every one of those a two-step correction. Clamps,
 *  because the caret is read before a native menu opens and the draft can be
 *  shorter by the time the pick comes back. */
export function insertAtCaret(draft: string, at: number, insert: string): string {
  const i = Math.max(0, Math.min(draft.length, at));
  return draft.slice(0, i) + insert + draft.slice(i);
}

/** Mirror of `isValidVariableName` in main/recorder/types.ts.
 *
 *  Duplicated for the same reason variables-panel.tsx duplicates it: the
 *  backend normalizes on write and remains the source of truth, and this copy
 *  only exists so the UI can refuse a name before the round-trip instead of
 *  watching the entry silently vanish. */
export function isValidVariableName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.length <= 40;
}

/** The kinds offered when declaring from a step. "captured" is deliberately
 *  absent: a captured variable is created BY a capture step, and offering it
 *  here would declare a name with nothing ever writing to it. */
/** Segment labels for the generator picker — the long labels live in
 *  GEN_SPEC_LABELS (variables tab); segments need short ones. */
const GEN_SPEC_SHORT: Record<GenSpec, string> = {
  string: "String",
  email: "Email",
  number: "Number",
  uuid: "UUID",
  name: "Name",
};

const NEW_VARIABLE_KINDS: { value: VariableKind; label: string }[] = [
  { value: "plain", label: "Value" },
  { value: "secret", label: "Secret" },
  { value: "generated", label: "Generated" },
];

/** What the trainer shows in place of a variable's value.
 *
 *  The trainer never displays one. A secret's value it could not reach if it
 *  wanted to (it lives encrypted, backend-side, and no IPC handler returns it);
 *  a plain one it does hold, because the session broadcasts the declarations —
 *  and that is exactly the value this app was given to keep, so printing it
 *  back into a panel that gets screen-shared, screenshotted and persisted is
 *  not something to do by default. The one exception is the field the user is
 *  typing into right now in `NewVariableForm`, where hiding what they are
 *  entering would help nobody.
 *
 *  A marker rather than a blank, so "this variable has a value" stays visible.
 *  The absence of one is real information too — a secret declared on the
 *  Variables tab and never given a value is what makes a replay fail with
 *  "nothing to fill". */
export const MASKED_VALUE = "****";

/** Does this variable carry a value the trainer is deliberately not showing? */
export function hasMaskedValue(v: TestVariable): boolean {
  // A secret ALWAYS masks: its value lives where this process cannot look, so
  // "no value here" would report the encrypted store as empty rather than
  // unreadable — a claim this side is in no position to make.
  return v.kind === "secret" || !!v.value;
}

/**
 * The declared variables, as buttons that insert a reference.
 *
 * `selected` is optional: the fill composer uses it as a radio group (one
 * variable IS the value), and the inline step editor doesn't (a click appends a
 * reference to whatever is already typed).
 */
export function VariableChips({
  variables,
  onPick,
  selected,
  emptyHint,
  label,
}: {
  variables: TestVariable[];
  onPick: (name: string) => void;
  /** name of the variable currently chosen, when this picker is a choice */
  selected?: string;
  /** what to say when the test declares none yet */
  emptyHint?: React.ReactNode;
  label?: string;
}) {
  if (variables.length === 0) {
    return emptyHint ? (
      <Text variant="small" color="tertiary">
        {emptyHint}
      </Text>
    ) : null;
  }
  return (
    <div className="flex flex-col gap-1">
      {label ? (
        <Text variant="small" color="secondary">
          {label}
        </Text>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {variables.map((v) => {
          const active = selected === v.name;
          return (
            <button
              key={v.name}
              type="button"
              aria-pressed={selected === undefined ? undefined : active}
              onClick={() => onPick(v.name)}
              className={
                active
                  ? "flex items-center gap-1 rounded-md border border-accent bg-accent/10 px-2 py-0.5 text-left text-small"
                  : "flex items-center gap-1 rounded-md border border-separator px-2 py-0.5 text-left text-small transition-colors hover:border-accent hover:bg-accent/5"
              }
            >
              {v.kind === "secret" ? (
                <KeyRound className="size-3 text-tertiary" />
              ) : (
                <Variable className="size-3 text-tertiary" />
              )}
              <span className="font-mono">{varRef(v.name)}</span>
              {hasMaskedValue(v) ? (
                <span className="font-mono text-tertiary" aria-label={`${v.name} value hidden`}>
                  {MASKED_VALUE}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Declare a variable without leaving the step you are building.
 *
 * `onCreate` rejects with a message meant to be read — the backend owns the
 * rules (valid name, no duplicate, no empty secret) and this form shows what it
 * says rather than second-guessing it. The one check made locally is the name
 * shape, so the common typo is caught before a round-trip.
 */
export function NewVariableForm({
  onCreate,
  onCancel,
  existingNames,
}: {
  onCreate: (v: { name: string; kind: VariableKind; value: string; genSpec?: GenSpec }) => Promise<void>;
  onCancel: () => void;
  existingNames: string[];
}) {
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<VariableKind>("secret");
  const [value, setValue] = React.useState("");
  const [genSpec, setGenSpec] = React.useState<GenSpec>("string");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const trimmed = name.trim();
  const nameOk = isValidVariableName(trimmed);
  const duplicate = existingNames.includes(trimmed);
  const ready = nameOk && !duplicate && !busy && (kind !== "secret" || value !== "");

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name: trimmed, kind, value, ...(kind === "generated" ? { genSpec } : {}) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-separator p-3"
      data-gl="new-variable"
    >
      <Field label="Name" orientation="vertical">
        <Input
          size="small"
          autoFocus
          aria-label="New variable name"
          value={name}
          placeholder="storePassword"
          className="font-mono"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </Field>
      {trimmed && !nameOk ? (
        <Text variant="small" color="red">
          Use letters, numbers and underscores, starting with a letter — the name becomes a
          property in the generated spec.
        </Text>
      ) : null}
      {nameOk && duplicate ? (
        <Text variant="small" color="red">
          This test already declares “{trimmed}”. Pick it from the list instead.
        </Text>
      ) : null}

      <Field label="Kind" orientation="vertical">
        <SegmentedControl size="small" value={kind} onValueChange={(v) => setKind(v as VariableKind)}>
          {NEW_VARIABLE_KINDS.map((k) => (
            <SegmentedControlItem key={k.value} value={k.value}>
              {k.label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </Field>

      {kind === "generated" ? (
        <Field label="Generates" orientation="vertical">
          <SegmentedControl
            size="small"
            value={genSpec}
            onValueChange={(v) => setGenSpec(v as GenSpec)}
          >
            {GEN_SPECS.map((g) => (
              <SegmentedControlItem key={g} value={g}>
                {GEN_SPEC_SHORT[g]}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </Field>
      ) : (
        <Field label={kind === "secret" ? "Value (stored encrypted)" : "Value"} orientation="vertical">
          <Input
            size="small"
            aria-label="New variable value"
            type={kind === "secret" ? "password" : "text"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </Field>
      )}

      {kind === "secret" ? (
        <Text variant="small" color="secondary">
          Encrypted on this Mac and never shown again — here or anywhere else in the trainer. The
          real value IS typed into the page when a step replays or the test runs; what the trainer
          prints back is <code className="font-mono">{MASKED_VALUE}</code>. The spec gets an
          environment reference, not the value, and it is stripped from run logs and anything sent
          to a hosted model.
        </Text>
      ) : kind === "generated" ? (
        <Text variant="small" color="secondary">
          A fresh value on every run (this session keeps one sample so steps can use it now).
          Emails use @example.com, so a signup test can never mail a real mailbox.
        </Text>
      ) : (
        <Callout color="yellow" icon={<TriangleAlert className="size-4" />}>
          <Callout.Text>
            A <strong>Value</strong> variable is stored as plain text — in this test&apos;s record
            and in the generated spec. Choose <strong>Secret</strong> for a password.
          </Callout.Text>
        </Callout>
      )}

      {error ? (
        <Text variant="small" color="red">
          {error}
        </Text>
      ) : null}

      <div className="flex items-center gap-2">
        <Button size="small" variant="accent" disabled={!ready} onClick={() => void submit()}>
          {busy ? "Saving…" : "Create variable"}
        </Button>
        <Button size="small" variant="glass" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The affordance that opens `NewVariableForm`, so the three hosts don't each
 *  invent a button for it. */
export function NewVariableButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="small" variant="glass" className="w-fit" onClick={onClick}>
      <Plus className="size-3.5" />
      New variable
    </Button>
  );
}

/** A one-line reminder of where a plain value ends up, for the places that show
 *  existing variables rather than creating one. */
export function PlaintextVariableNotice({ variables }: { variables: TestVariable[] }) {
  const plain = variables.filter((v) => v.kind !== "secret").length;
  if (plain === 0) return null;
  return (
    <Text variant="small" color="tertiary">
      <Badge variant="secondary">plain text</Badge> Value and captured variables are stored
      unencrypted on this Mac. Use a Secret for a password.
    </Text>
  );
}
