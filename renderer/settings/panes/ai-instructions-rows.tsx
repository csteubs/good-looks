// Standing instructions for the Script editor's inline AI: one global text,
// and one per site. Prepended to every ⌘K rewrite and every Explain — the
// place for house locator rules and a site's quirks, so they are not retyped
// into each request. Saved on blur, through the settings controller like
// every other row; the per-site table is sent whole on each change, which
// is what lets a host be removed.

import { useState } from "react";

import { Button, Input } from "@ui";

import { useSettingsController } from "../settings-controller";
import { SettingRow } from "../setting-row";

export const INSTRUCTIONS_MAX = 4000;

export function AiInstructionsRows() {
  const { settings, save } = useSettingsController();
  const global = settings.aiInstructions ?? "";
  const byHost = settings.aiInstructionsByHost ?? {};
  const [draft, setDraft] = useState<string | null>(null);
  const [hostDrafts, setHostDrafts] = useState<Record<string, string>>({});
  const [newHost, setNewHost] = useState("");

  const commitGlobal = () => {
    if (draft !== null && draft !== global) void save({ aiInstructions: draft.slice(0, INSTRUCTIONS_MAX) });
    setDraft(null);
  };
  const commitHost = (host: string) => {
    const text = hostDrafts[host];
    if (text === undefined) return;
    // A new site with nothing written yet stays a draft row: saving it would
    // drop it (blank texts are not kept), and there is nothing to save.
    if (!text.trim() && !(host in byHost)) return;
    const next = { ...byHost };
    if (text.trim()) next[host] = text.slice(0, INSTRUCTIONS_MAX);
    else delete next[host];
    void save({ aiInstructionsByHost: next });
    setHostDrafts((d) => {
      const { [host]: _gone, ...rest } = d;
      return rest;
    });
  };
  const addHost = () => {
    const host = newHost.trim().toLowerCase();
    if (!host || host in byHost) return;
    // An empty text would be dropped on save, so the new host lives as a
    // draft until something is written for it.
    setHostDrafts((d) => ({ ...d, [host]: "" }));
    setNewHost("");
  };
  const removeHost = (host: string) => {
    const { [host]: _gone, ...rest } = byHost;
    void save({ aiInstructionsByHost: rest });
  };

  const hosts = Array.from(new Set([...Object.keys(byHost), ...Object.keys(hostDrafts)])).sort();

  return (
    <>
      <SettingRow
        id="llm-instructions"
        label="Standing instructions"
        summary="Prepended to every rewrite and explanation the Script editor asks for: house locator rules, a framework's quirks, what never to change. Sent with the prompt, so it counts toward the budget line."
      >
        <textarea
          id="llm-instructions"
          className="gl-setting-textarea"
          rows={4}
          maxLength={INSTRUCTIONS_MAX}
          placeholder="Prefer getByRole over CSS. Never add waitForTimeout…"
          value={draft ?? global}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitGlobal}
        />
      </SettingRow>
      <SettingRow
        id="llm-instructions-by-host"
        label="Instructions per site"
        summary="Added when the test's address is on that host — exactly that host, not its subdomains."
      >
        <div className="gl-setting-hosts">
          {hosts.map((host) => (
            <div key={host} className="gl-setting-host" data-host={host}>
              <div className="gl-setting-host-head">
                <span className="gl-setting-host-name">{host}</span>
                <Button variant="muted" onClick={() => removeHost(host)} aria-label={`Remove ${host}`}>
                  Remove
                </Button>
              </div>
              <textarea
                className="gl-setting-textarea"
                rows={3}
                maxLength={INSTRUCTIONS_MAX}
                aria-label={`Instructions for ${host}`}
                value={hostDrafts[host] ?? byHost[host] ?? ""}
                onChange={(e) => setHostDrafts((d) => ({ ...d, [host]: e.target.value }))}
                onBlur={() => commitHost(host)}
              />
            </div>
          ))}
          <div className="gl-setting-host-add">
            <Input
              id="llm-instructions-by-host"
              className="w-56"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="shop.example.com"
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addHost();
                }
              }}
            />
            <Button variant="muted" onClick={addHost} disabled={!newHost.trim()}>
              Add site
            </Button>
          </div>
        </div>
      </SettingRow>
    </>
  );
}
