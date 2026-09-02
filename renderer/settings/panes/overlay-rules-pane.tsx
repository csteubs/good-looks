// Settings → Overlay rules: the standing "click this away whenever it appears"
// records, grouped by host.
//
// Three rules from the store surface here as UI shape rather than copy:
//
//   • THE TARGET IS NOT EDITABLE. A rule's locator comes from the trainer's
//     element picker, where it was priced against a real page. Letting it be
//     retyped here is how a rule acquires a selector nobody ever saw match —
//     so the row shows what it targets and offers "re-teach" rather than a
//     text field.
//   • DISABLE IS NOT DELETE. Disabling stops a rule firing while keeping the
//     definition, which is what you want while working out whether a rule is
//     the thing breaking a run. Delete is separate and explicit.
//   • RULES ARE PER-HOST AND MACHINE-LOCAL. Grouping by host is the honest
//     presentation of what they are; the note says the second half out loud,
//     because a test that depends on a rule behaves differently on a machine
//     without it and there is nothing in the test to explain why.
//
// The section ABOVE the rules is the switch over all of them plus the
// BUILT-IN handlers (shared/popup-presets.mjs). Two settings, and they read from
// the settings controller rather than from react-query, because they are
// RecorderSettings like everything else in this window — "reset section" and
// the modified count have to see them. The taught rules stay on react-query:
// they live in their own store, arrive on their own push, and no default
// describes them.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Button, Input, Switch, toast } from "@ui";
import { api } from "../../lib/api";
import type { Locator, OverlayRule } from "../../lib/recorder-types";
import { MAX_OVERLAY_LABEL, MAX_RULES_PER_HOST } from "../../../shared/overlay-rules.mjs";
import { DEFAULT_HANDLE_POPUPS, POPUP_PRESETS } from "../../../shared/popup-presets.mjs";
import { useSettingsController } from "../settings-controller";
import { PaneSection } from "../pane-section";
import { SettingRow } from "../setting-row";

/** The Documentation topic the "How pop-up handling works" link opens. A slug
 *  of docs/POPUPS-GUIDE.md; `check:docs-blocks` is what proves it exists. */
const HANDLE_POPUPS_DOC_SLUG = "handle-pop-ups";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What a rule points at, in the words the trainer's step list uses.
 *
 *  Deliberately the locator's own vocabulary rather than a CSS selector for
 *  every kind: a rule taught off a role reads as `button "Close"` here and in
 *  the step list, and a person comparing the two should not have to translate. */
export function describeTarget(target: Locator): string {
  if (target.k === "role") {
    return target.name ? `${target.role} “${target.name}”` : String(target.role ?? "role");
  }
  if (target.k === "testid") {
    return `${target.attr ?? "data-testid"}="${target.v ?? ""}"`;
  }
  if (target.k === "text") return `text “${target.v ?? ""}”`;
  return target.v ?? target.k;
}

export function OverlayRulesPane({
  onOpenDoc,
}: {
  /** Opens a Documentation topic by slug. Panes are router-free by rule, so
   *  the routed wrapper in settings-view.tsx supplies this and a pane test
   *  passes a spy. Absent (the browser preview mounting the pane bare), the
   *  link is inert rather than a crash. */
  onOpenDoc?: (slug: string) => void;
} = {}) {
  const { settings, save } = useSettingsController();
  const handlePopups = settings.defaultHandlePopups ?? DEFAULT_HANDLE_POPUPS;
  const disabledPresets = settings.disabledPopupPresets ?? [];
  const setPresetEnabled = (id: string, enabled: boolean) => {
    const without = disabledPresets.filter((d) => d !== id);
    void save({ disabledPopupPresets: enabled ? without : [...without, id] });
  };

  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ["overlay-rules"], queryFn: api.overlayRules.list });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");

  const refetch = () => void qc.invalidateQueries({ queryKey: ["overlay-rules"] });

  // A rule taught in the TRAINER lands while this window is open, and the list
  // would otherwise sit stale until the pane was re-opened. This is the whole
  // reason `overlayRules:changed` is pushed.
  useEffect(() => api.on("overlayRules:changed", refetch), []);

  const update = useMutation({
    mutationFn: (input: { id: string; patch: { label?: string; disabled?: boolean } }) =>
      api.overlayRules.update(input.id, input.patch),
    onSuccess: () => {
      setEditingId(null);
      refetch();
    },
    onError: (err: unknown) => toast.error(errorText(err)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.overlayRules.remove(id),
    onSuccess: refetch,
    onError: (err: unknown) => toast.error(errorText(err)),
  });

  const all = rules.data ?? [];
  // Grouped by host, hosts alphabetical, rules oldest first within a host so
  // the order a person taught them in is the order they read them back in.
  const hosts = [...new Set(all.map((r) => r.host))].sort();
  const byHost = (host: string): OverlayRule[] =>
    all.filter((r) => r.host === host).sort((a, b) => a.createdAt - b.createdAt);

  return (
    <>
      <PaneSection
        title="Handle pop-ups"
        description="Whether a run or a recording clicks pop-ups away at all, and the handlers this app ships for vendors it already knows."
      >
        <SettingRow
          id="popups-default"
          label="Handle pop-ups"
          summary="On for every test unless the test's own Handle pop-ups box says otherwise. Off: no banner is clicked away in the trainer or in a run — the built-in handlers and your own rules included."
          details="The per-test override lives in the run options — the Handle pop-ups box on a test's own screen, beside Record console & network — and the New recording dialog has the same box for the trainer session. A test whose point is the pop-up (signing up to the newsletter form, say) turns it off there and leaves this default alone. Off is all the way off on purpose: half a switch, with the built-in handlers off and your rules still on, would leave a test that asserts on the consent banner watching it vanish anyway."
          doc={{
            label: "How pop-up handling works",
            onOpen: () => onOpenDoc?.(HANDLE_POPUPS_DOC_SLUG),
          }}
        >
          <Switch
            id="popups-default"
            checked={handlePopups}
            onCheckedChange={(checked) => void save({ defaultHandlePopups: checked })}
          />
        </SettingRow>

        <SettingRow
          id="popups-presets"
          label="Built-in handlers"
          stacked
          summary="Close controls this app already knows: Klaviyo sign-up forms and DataGrail consent banners. Each clicks only that vendor's own Close control — never Accept or Reject on a consent banner — and matches nothing on a site that does not use the vendor. Armed on every site whenever Handle pop-ups is on; switch one off here to keep that vendor's pop-up."
          details="These exist for the pop-up that has not shown up yet. A rule is taught by right-clicking the overlay in the trainer, so a form that arrives on a timer or on exit intent — never during the recording, always at 3am in a run — has nothing to right-click. Each handler is scoped to markup only its vendor renders, which is what lets it ship without a host list."
        >
          <ul className="flex w-full flex-col gap-2">
            {POPUP_PRESETS.map((preset) => {
              const disabled = disabledPresets.indexOf(preset.id) !== -1;
              return (
                <li key={preset.id} className="flex items-center gap-2">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={`truncate text-sm${disabled ? " opacity-50" : ""}`}>
                        {preset.label}
                      </span>
                      <span className="text-xs opacity-60">{preset.vendor}</span>
                    </span>
                    {/* What it clicks, always visible — the same rule as a taught
                        rule below: a handler whose target cannot be seen is one
                        the user cannot judge when a run behaves oddly. */}
                    <span className="truncate font-mono text-xs opacity-50">
                      {describeTarget(preset.target as Locator)}
                    </span>
                  </span>
                  <Switch
                    aria-label={`Enable ${preset.label}`}
                    checked={!disabled}
                    onCheckedChange={(checked) => setPresetEnabled(preset.id, checked)}
                  />
                </li>
              );
            })}
          </ul>
        </SettingRow>
      </PaneSection>

      <PaneSection
        title="Overlay rules"
        description="Standing dismissals for the banners a site puts over itself — consent modals, newsletter pop-ups, app-install interstitials."
      >
        <SettingRow
          id="overlay-rules-what"
          label="How they work"
          stacked
          summary={
            <>
              A rule is taught in the trainer: right-click the control that closes the overlay and
              choose “Always dismiss this overlay”. From then on the recorder and every run of a
              test on that host click it away whenever it appears — on the first page and on every
              page a later navigation produces. A rule can never fail a run; an overlay that never
              shows up is simply a rule that does not fire. Up to {MAX_RULES_PER_HOST} rules per
              host.
            </>
          }
          details="Rules live on this Mac rather than on a test, because a pop-up is a property of the site and a copy on every test that visits it is a copy that drifts. The consequence is worth knowing: a colleague running the same test without the rule will see the overlay, so each run says in its output which rules were armed."
        >
          <span className="text-xs opacity-60">
            {all.length === 0
              ? "No rules yet"
              : `${all.length} rule${all.length === 1 ? "" : "s"} across ${hosts.length} host${hosts.length === 1 ? "" : "s"}`}
          </span>
        </SettingRow>
      </PaneSection>

      {hosts.map((host) => (
        <PaneSection key={host} title={host}>
          <SettingRow
            id={`overlay-rules-${host}`}
            label={`${byHost(host).length} rule${byHost(host).length === 1 ? "" : "s"}`}
            stacked
          >
            <ul className="flex w-full flex-col gap-2">
              {byHost(host).map((rule) =>
                editingId === rule.id ? (
                  <li key={rule.id} className="flex flex-col gap-2">
                    <Input
                      value={editLabel}
                      maxLength={MAX_OVERLAY_LABEL}
                      onChange={(e) => setEditLabel(e.target.value)}
                      aria-label={`New name for ${rule.label || describeTarget(rule.target)}`}
                      className="min-w-0"
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        disabled={update.isPending}
                        onClick={() => update.mutate({ id: rule.id, patch: { label: editLabel } })}
                      >
                        Save
                      </Button>
                      <Button variant="transparent" onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </li>
                ) : (
                  <li key={rule.id} className="flex items-center gap-2">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={`truncate text-sm${rule.disabled ? " opacity-50" : ""}`}>
                        {rule.label || describeTarget(rule.target)}
                      </span>
                      {/* What it actually clicks, always visible: a rule the
                          user cannot see the target of is a rule they cannot
                          judge when a run behaves oddly. */}
                      <span className="truncate font-mono text-xs opacity-50">
                        {describeTarget(rule.target)}
                      </span>
                    </span>
                    <Switch
                      aria-label={`Enable ${rule.label || describeTarget(rule.target)}`}
                      checked={!rule.disabled}
                      onCheckedChange={(checked) =>
                        update.mutate({ id: rule.id, patch: { disabled: !checked } })
                      }
                    />
                    <Button
                      variant="transparent"
                      onClick={() => {
                        setEditingId(rule.id);
                        setEditLabel(rule.label);
                      }}
                    >
                      Rename
                    </Button>
                    <Button
                      variant="transparent"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(rule.id)}
                    >
                      Delete
                    </Button>
                  </li>
                ),
              )}
            </ul>
          </SettingRow>
        </PaneSection>
      ))}
    </>
  );
}
