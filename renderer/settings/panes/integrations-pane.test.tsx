// Tests for the Integrations pane.
//
// Three credentials live here, and all three are write-only: the value goes
// renderer→backend, is stored encrypted, and is never read back. These tests
// assert on what CROSSES the boundary and on what reaches the screen, not just
// on what renders.
//
// The webhook half was carried over verbatim from `alerts-pane.test.tsx` when
// the row moved, including the 2026-08-06 copy correction. It must keep
// holding — the move was a relocation, not a rewrite, and the way that goes
// wrong is a guarantee quietly not surviving the journey.
//
// The Linear half pins the one distinction the pane is built around: "a key is
// saved" and "the key works" are different claims, and the pane makes both.

import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";

import { makeController, renderPane, savedPatch } from "../__tests__/harness";
import type { ShopifySignatureStatus } from "../../lib/recorder-types";
import type { SettingsController } from "../settings-controller";
import { IntegrationsPane } from "./integrations-pane";

/** Scope queries to one row. Three credential rows carry a Save button, so an
 *  unscoped `getByRole("button", {name: /save/i})` matches several and reports
 *  as "found multiple elements" rather than as the wrong row. */
function row(id: string): HTMLElement {
  const el = document.querySelector(`[data-setting-row="${id}"]`);
  if (!el) throw new Error(`No row "${id}" on screen`);
  return el as HTMLElement;
}

/**
 * A row's control, by id.
 *
 * NOT `getByLabelText`. Every button in this pane carries an `aria-label`
 * naming the credential it acts on ("Save webhook URL"), which is what makes
 * three identical-looking Save buttons distinguishable — and it also makes
 * `getByLabelText(/webhook url/i)` match the input AND two buttons, reporting
 * as "found multiple elements". `SettingRow` wires `htmlFor` to the row id and
 * the control carries the same id, and that association is covered by
 * `setting-row.test.tsx`, so addressing the id here is precise rather than a
 * shortcut around the label.
 */
function fieldById(id: string): HTMLInputElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`No control "${id}" on screen`);
  return el as HTMLInputElement;
}

function queryField(id: string): HTMLElement | null {
  return document.getElementById(id);
}

const connected = (over: Partial<SettingsController> = {}) =>
  makeController({
    issuesStatus: {
      provider: "linear",
      hasKey: true,
      account: { accountName: "Sam Rivera", workspaceName: "Northwind" },
      error: null,
    },
    issueContainers: [
      { id: "team-eng", name: "Engineering", key: "ENG" },
      { id: "team-design", name: "Design", key: "DES" },
    ],
    issueSubContainers: [
      { id: "proj-checkout", name: "Checkout revamp", containerId: "team-eng" },
      { id: "proj-a11y", name: "Accessibility debt", containerId: null },
      { id: "proj-ds", name: "Design system", containerId: "team-design" },
    ],
    ...over,
  });

describe("the Linear key is write-only", () => {
  it("masks the field so a pasted key isn't shoulder-readable", () => {
    renderPane(<IntegrationsPane />);
    expect(fieldById("linear-connection").getAttribute("type")).toBe("password");
  });

  it("hands the key over and then clears the field", async () => {
    const { controller } = renderPane(<IntegrationsPane />);
    const field = fieldById("linear-connection");
    fireEvent.change(field, { target: { value: "lin_api_SECRETVALUE" } });
    fireEvent.click(screen.getByRole("button", { name: /save linear api key/i }));

    await waitFor(() => expect(controller.connectIssues).toHaveBeenCalledTimes(1));
    expect(controller.connectIssues).toHaveBeenCalledWith("lin_api_SECRETVALUE");
    // Cleared once handed over: the renderer must not be the one place a
    // write-only credential lingers for the rest of the session.
    await waitFor(() => expect(field.value).toBe(""));
  });

  it("keeps what was typed when the save is rejected", () => {
    const controller = makeController({ connectIssues: async () => false });
    renderPane(<IntegrationsPane />, { controller });
    const field = fieldById("linear-connection");
    fireEvent.change(field, { target: { value: "lin_api_TYPO" } });
    fireEvent.click(screen.getByRole("button", { name: /save linear api key/i }));
    expect(field.value).toBe("lin_api_TYPO");
  });

  it("refuses to save an empty field", () => {
    renderPane(<IntegrationsPane />);
    expect(
      (screen.getByRole("button", { name: /save linear api key/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("never puts the key on screen once stored", () => {
    renderPane(<IntegrationsPane />, { controller: connected() });
    const field = fieldById("linear-connection");
    expect(field.value).toBe("");
    expect(field.getAttribute("placeholder")).toBe("••••••••");
    expect(document.body.textContent).not.toMatch(/lin_api_/);
  });
});

describe("saved and working are different claims", () => {
  it("says Connected, and who, once verified", () => {
    renderPane(<IntegrationsPane />, { controller: connected() });
    expect(screen.getByText(/^Connected$/)).toBeTruthy();
    expect(row("linear-connection").textContent).toMatch(/Sam Rivera/);
    expect(row("linear-connection").textContent).toMatch(/Northwind/);
  });

  it("says Not connected — with the reason — for a key that is stored but failed", () => {
    // The case that matters: the key IS on disk, so a pane keying off `hasKey`
    // alone would show "Connected" for a key Linear has revoked.
    const controller = makeController({
      issuesStatus: {
        provider: "linear",
        hasKey: true,
        account: null,
        error: "Linear rejected the API key.",
      },
    });
    renderPane(<IntegrationsPane />, { controller });
    expect(screen.getByText(/not connected/i)).toBeTruthy();
    expect(row("linear-connection").textContent).toMatch(/rejected the API key/i);
  });

  it("shows no status chip at all before a key is saved", () => {
    // Neither claim is true yet, and "Not connected" for someone who has not
    // started reads as a failure rather than as an empty state.
    renderPane(<IntegrationsPane />);
    expect(screen.queryByText(/^Connected$/)).toBeNull();
    expect(screen.queryByText(/not connected/i)).toBeNull();
  });

  it("offers Test connection and Disconnect only once a key is stored", () => {
    const { unmount } = renderPane(<IntegrationsPane />);
    expect(screen.queryByRole("button", { name: /test the linear connection/i })).toBeNull();
    unmount();

    renderPane(<IntegrationsPane />, { controller: connected() });
    expect(screen.getByRole("button", { name: /test the linear connection/i })).toBeTruthy();
  });

  it("re-verifies on demand", async () => {
    const controller = connected();
    renderPane(<IntegrationsPane />, { controller });
    fireEvent.click(screen.getByRole("button", { name: /test the linear connection/i }));
    await waitFor(() => expect(controller.verifyIssues).toHaveBeenCalledTimes(1));
  });

  it("disconnects", async () => {
    const controller = connected();
    renderPane(<IntegrationsPane />, { controller });
    fireEvent.click(screen.getByRole("button", { name: /disconnect linear/i }));
    await waitFor(() => expect(controller.disconnectIssues).toHaveBeenCalledTimes(1));
  });

  it("disables its controls while a call is in flight", () => {
    const controller = connected({ issuesBusy: true });
    renderPane(<IntegrationsPane />, { controller });
    expect(
      (screen.getByRole("button", { name: /test the linear connection/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: /disconnect linear/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("the default destination", () => {
  it("is offered only once the connection works", () => {
    // A team picker with nothing in it is worse than no picker: it reads as
    // "this workspace has no teams" rather than "we haven't asked yet".
    const { unmount } = renderPane(<IntegrationsPane />);
    expect(queryField("linear-default-team")).toBeNull();
    unmount();

    renderPane(<IntegrationsPane />, { controller: connected() });
    expect(fieldById("linear-default-team")).toBeTruthy();
  });

  it("counts what is available", () => {
    renderPane(<IntegrationsPane />, { controller: connected() });
    expect(row("linear-default-team").textContent).toMatch(/2 teams/i);
  });

  it("shows the chosen team, not a placeholder", () => {
    // The Select is native-menu-backed, so its options never enter the DOM and
    // no query reaches them. The displayed value is the assertable half.
    const controller = connected({
      issueDefaults: { containerId: "team-eng", subContainerId: null },
    });
    renderPane(<IntegrationsPane />, { controller });
    expect(within(row("linear-default-team")).getByText(/ENG — Engineering/)).toBeTruthy();
  });

  it("hides the project row until a team is chosen", () => {
    // A project belongs to a team, so offering one first would present a list
    // that cannot be filtered and a choice that cannot be honoured.
    const { unmount } = renderPane(<IntegrationsPane />, { controller: connected() });
    expect(queryField("linear-default-project")).toBeNull();
    unmount();

    renderPane(<IntegrationsPane />, {
      controller: connected({
        issueDefaults: { containerId: "team-eng", subContainerId: null },
      }),
    });
    expect(fieldById("linear-default-project")).toBeTruthy();
  });

  it("shows the chosen project", () => {
    const controller = connected({
      issueDefaults: { containerId: "team-eng", subContainerId: "proj-checkout" },
    });
    renderPane(<IntegrationsPane />, { controller });
    expect(within(row("linear-default-project")).getByText(/Checkout revamp/)).toBeTruthy();
  });
});

/** The labels a native-menu-backed `Select` would show. See the note on
 *  `chooseFromNativeMenu` — this is the same seam, read rather than clicked. */
function nativeMenuLabels(triggerId: string): string[] {
  interface Item { label?: string; commandId?: number }
  const seen: string[] = [];
  const popup = vi.fn(async ({ items }: { items: Item[] }) => {
    for (const i of items) if (i.label) seen.push(i.label);
    return {};
  });
  (window as unknown as { glazeAPI: { Menu: unknown } }).glazeAPI = { Menu: { popup } };
  fireEvent.click(document.getElementById(triggerId) as HTMLElement);
  return seen;
}

/**
 * Choose an option from the app's native-menu-backed `Select`.
 *
 * Same seam and same reasoning as `appearance-pane.test.tsx`: the OPTIONS never
 * enter the DOM, but the menu is opened through `glazeAPI.Menu.popup`, which is
 * an ordinary promise a test can answer.
 */
function chooseFromNativeMenu(triggerId: string, label: string): void {
  interface Item { label?: string; commandId?: number }
  const popup = vi.fn(async ({ items }: { items: Item[] }) => {
    const hit = items.find((i) => i.label === label && i.commandId !== undefined);
    if (!hit) {
      throw new Error(`no menu item labelled "${label}" (saw: ${items.map((i) => i.label).join(", ")})`);
    }
    return { commandId: hit.commandId };
  });
  (window as unknown as { glazeAPI: { Menu: unknown } }).glazeAPI = { Menu: { popup } };
  fireEvent.click(document.getElementById(triggerId) as HTMLElement);
}

describe("the tracker is chosen here", () => {
  const LINEAR = {
    id: "linear" as const,
    hasKey: false,
    vocabulary: {
      name: "Linear",
      container: "Team",
      containerPlural: "Teams",
      subContainer: "Project",
      keyHelpUrl: "",
      keyPlaceholder: "lin_api_…",
      supportsImageUpload: true,
    },
  };

  const GITHUB = {
    id: "github" as const,
    hasKey: false,
    vocabulary: {
      name: "GitHub",
      container: "Repository",
      containerPlural: "Repositories",
      subContainer: "Milestone",
      keyHelpUrl: "https://github.com/settings/tokens",
      keyPlaceholder: "ghp_…",
      supportsImageUpload: false,
    },
  };

  it("offers the choice at all", () => {
    // The row exists and is a control, not prose. Before this the provider was
    // a constant in the main process and there was nothing to click.
    renderPane(<IntegrationsPane />, { controller: connected() });
    expect(fieldById("issue-tracker-provider")).toBeTruthy();
  });

  it("shows the tracker in use, not a placeholder", () => {
    // Same constraint as the team Select: native-menu-backed, so its options
    // never enter the DOM and the displayed value is the assertable half.
    renderPane(<IntegrationsPane />, { controller: connected() });
    expect(within(row("issue-tracker-provider")).getByText(/Linear/)).toBeTruthy();
  });

  it("labels every row with the SELECTED provider's own words", () => {
    // The whole reason the vocabulary crosses IPC. A pane that hardcoded "Team"
    // would ask a GitHub user to choose a default team, which is not a thing
    // GitHub has.
    const controller = connected({
      issuesStatus: {
        provider: "github",
        hasKey: true,
        account: { accountName: "Sam Rivera", workspaceName: null },
        error: null,
      },
      issuesVocabulary: GITHUB.vocabulary,
      issueContainers: [{ id: "acme/storefront", name: "storefront", key: "acme" }],
      issueDefaults: { containerId: "acme/storefront", subContainerId: null },
    });
    renderPane(<IntegrationsPane />, { controller });
    expect(row("linear-default-team").textContent).toMatch(/default repository/i);
    expect(row("linear-default-project").textContent).toMatch(/default milestone/i);
    expect(within(row("linear-connection")).getByLabelText(/Save GitHub API key/i)).toBeTruthy();
  });

  it("switches when a different tracker is picked", async () => {
    // The options never enter the DOM (native-menu-backed Select), but the menu
    // is opened through `glazeAPI.Menu.popup` — an ordinary promise this test
    // answers, which runs exactly the handler a real click would. Worth the
    // scaffolding here: this row IS the feature, and a picker wired to nothing
    // renders identically to one that works.
    const controller = connected({ issueProviders: [LINEAR, GITHUB] });
    renderPane(<IntegrationsPane />, { controller });
    chooseFromNativeMenu("issue-tracker-provider", "GitHub");
    await waitFor(() => expect(controller.selectIssueProvider).toHaveBeenCalledWith("github"));
  });

  it("says which trackers already have a key", () => {
    // The only on-screen answer to "which of these am I set up for?". Without
    // it, switching to an unconfigured tracker looks identical to switching to
    // a configured one until the next send fails.
    const controller = connected({
      issueProviders: [{ ...GITHUB, hasKey: true }, LINEAR],
    });
    renderPane(<IntegrationsPane />, { controller });
    // Read off the menu the trigger actually builds, since the items never
    // reach the DOM to be queried.
    expect(nativeMenuLabels("issue-tracker-provider")).toEqual(
      expect.arrayContaining(["GitHub — key saved", "Linear"]),
    );
  });

  it("warns that a tracker without image upload will not carry screenshots", () => {
    // Said in Settings as well as in the dialog, because this is where somebody
    // chooses it — and a visual-difference workflow whose evidence silently
    // stops arriving is the expensive way to find out.
    renderPane(<IntegrationsPane />, {
      controller: connected({ issuesVocabulary: GITHUB.vocabulary }),
    });
    expect(row("issue-tracker-provider").textContent).toMatch(/cannot accept image attachments/i);
  });

  it("says nothing about attachments for a tracker that does carry them", () => {
    // A warning shown on every provider is one nobody reads on the provider it
    // is true for.
    renderPane(<IntegrationsPane />, { controller: connected() });
    expect(row("issue-tracker-provider").textContent).not.toMatch(/cannot accept image/i);
  });

  it("keeps the branch switcher's token as a separate field", () => {
    // Two GitHub token fields is confusing enough to be worth pinning: they are
    // separate because disconnecting the issue tracker clears its key, and
    // pointing that at this one would silently stop the branch switcher listing
    // pull requests in another window.
    renderPane(<IntegrationsPane />, { controller: connected() });
    expect(fieldById("github-token")).toBeTruthy();
    expect(row("github-token").textContent).toMatch(/branch switcher/i);
  });
});

describe("the alert webhook is write-only", () => {
  it("keeps the enable switch disabled until a URL is configured", () => {
    // Enabling alerts with no destination would silently do nothing.
    renderPane(<IntegrationsPane />);
    const sw = screen.getByRole("switch", { name: /send alerts to a webhook/i });
    expect(sw.getAttribute("data-disabled") ?? sw.getAttribute("disabled")).not.toBeNull();
  });

  it("enables the switch once a URL exists", () => {
    const controller = makeController({
      webhookStatus: { hasUrl: true, host: "hooks.example.com" },
    });
    renderPane(<IntegrationsPane />, { controller });
    const sw = screen.getByRole("switch", { name: /send alerts to a webhook/i });
    expect(sw.getAttribute("data-disabled") ?? sw.getAttribute("disabled")).toBeNull();
  });

  it("saves a pasted URL and then clears the field", async () => {
    const { controller } = renderPane(<IntegrationsPane />);
    const field = fieldById("alert-webhook-url");
    fireEvent.change(field, { target: { value: "https://hooks.example.com/services/SECRET" } });
    fireEvent.click(screen.getByRole("button", { name: /save webhook url/i }));

    await waitFor(() => expect(controller.saveWebhookUrl).toHaveBeenCalledTimes(1));
    expect(controller.saveWebhookUrl).toHaveBeenCalledWith(
      "https://hooks.example.com/services/SECRET",
    );
    await waitFor(() => expect(field.value).toBe(""));
  });

  it("keeps what was typed when the save is rejected", () => {
    // Wiping the field on failure loses the URL and gives the user nothing to
    // correct — they'd have to go back to Slack for it.
    const controller = makeController({ saveWebhookUrl: async () => false });
    renderPane(<IntegrationsPane />, { controller });
    const field = fieldById("alert-webhook-url");
    fireEvent.change(field, { target: { value: "not-a-url" } });
    fireEvent.click(screen.getByRole("button", { name: /save webhook url/i }));
    expect(field.value).toBe("not-a-url");
  });

  it("never renders the stored URL — only its host", () => {
    const controller = makeController({
      webhookStatus: { hasUrl: true, host: "hooks.example.com" },
    });
    renderPane(<IntegrationsPane />, { controller });
    expect(screen.getByText(/hooks\.example\.com/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/services\/SECRET/);
  });

  it("masks the input so a pasted credential isn't shoulder-readable", () => {
    renderPane(<IntegrationsPane />);
    expect(fieldById("alert-webhook-url").getAttribute("type")).toBe("password");
  });

  it("offers Send test and Remove only once configured", () => {
    const { unmount } = renderPane(<IntegrationsPane />);
    expect(screen.queryByRole("button", { name: /send a test alert/i })).toBeNull();
    unmount();

    const controller = makeController({
      webhookStatus: { hasUrl: true, host: "hooks.example.com" },
    });
    renderPane(<IntegrationsPane />, { controller });
    expect(screen.getByRole("button", { name: /send a test alert/i })).toBeTruthy();
  });

  it("clears the stored URL", async () => {
    const controller = makeController({
      webhookStatus: { hasUrl: true, host: "hooks.example.com" },
    });
    renderPane(<IntegrationsPane />, { controller });
    fireEvent.click(screen.getByRole("button", { name: /remove webhook url/i }));
    await waitFor(() => expect(controller.clearWebhookUrl).toHaveBeenCalledTimes(1));
  });

  it("sends a test alert", async () => {
    const controller = makeController({
      webhookStatus: { hasUrl: true, host: "hooks.example.com" },
    });
    renderPane(<IntegrationsPane />, { controller });
    fireEvent.click(screen.getByRole("button", { name: /send a test alert/i }));
    await waitFor(() => expect(controller.testWebhook).toHaveBeenCalledTimes(1));
  });

  it("refuses to save an empty field", () => {
    renderPane(<IntegrationsPane />);
    expect(
      (screen.getByRole("button", { name: /save webhook url/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("disables its controls while a webhook call is in flight", () => {
    // Two saves racing would leave the stored URL and the displayed host
    // disagreeing about which one won.
    const controller = makeController({
      webhookBusy: true,
      webhookStatus: { hasUrl: true, host: "hooks.example.com" },
    });
    renderPane(<IntegrationsPane />, { controller });
    expect(
      (screen.getByRole("button", { name: /send a test alert/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: /remove webhook url/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("saves the enable toggle once a URL exists and the user confirms", async () => {
    const controller = makeController({
      webhookStatus: { hasUrl: true, host: "hooks.example.com" },
    });
    renderPane(<IntegrationsPane />, { controller });
    fireEvent.click(screen.getByRole("switch", { name: /send alerts to a webhook/i }));
    fireEvent.click(await screen.findByRole("button", { name: /send alerts/i }));
    await waitFor(() => expect(controller.save).toHaveBeenCalledTimes(1));
    expect(savedPatch(controller)).toEqual({ alertWebhookEnabled: true });
  });
});

describe("turning the webhook on asks first", () => {
  const configured = () =>
    makeController({ webhookStatus: { hasUrl: true, host: "hooks.example.com" } });

  it("saves nothing until the confirmation is accepted", async () => {
    // The switch is driven by the SAVED setting, so it must not appear to flip
    // while the dialog is still open — that would read as "already on, and now
    // I'm being asked whether I meant it".
    const controller = configured();
    renderPane(<IntegrationsPane />, { controller });
    const sw = screen.getByRole("switch", { name: /send alerts to a webhook/i });
    fireEvent.click(sw);

    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(controller.save).not.toHaveBeenCalled();
    expect(sw.getAttribute("data-state")).toBe("unchecked");
  });

  it("names the destination host in the confirmation", async () => {
    renderPane(<IntegrationsPane />, { controller: configured() });
    fireEvent.click(screen.getByRole("switch", { name: /send alerts to a webhook/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/hooks\.example\.com/);
    // The point of asking: it keeps sending afterwards without asking again.
    expect(dialog.textContent).toMatch(/automatically/i);
  });

  it("leaves the setting off when the confirmation is cancelled", async () => {
    const controller = configured();
    renderPane(<IntegrationsPane />, { controller });
    fireEvent.click(screen.getByRole("switch", { name: /send alerts to a webhook/i }));
    fireEvent.click(await screen.findByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(controller.save).not.toHaveBeenCalled();
  });

  it("turns OFF without asking", async () => {
    // Confirming the way out trains people to click through the one on the way
    // in, and stopping the sending is not the risky direction.
    const controller = makeController({
      webhookStatus: { hasUrl: true, host: "hooks.example.com" },
      settings: { alertWebhookEnabled: true },
    });
    renderPane(<IntegrationsPane />, { controller });
    fireEvent.click(screen.getByRole("switch", { name: /send alerts to a webhook/i }));
    expect(savedPatch(controller)).toEqual({ alertWebhookEnabled: false });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});

describe("the off-this-Mac warning", () => {
  it("is on screen with no disclosure to open", () => {
    // This is the only thing in the app that sends data off the Mac
    // automatically. Behind a "More" link, most users never read it.
    const { container } = renderPane(<IntegrationsPane />);
    const el = container.querySelector('[data-setting-row="alert-webhook-enabled"]');
    expect(el?.textContent).toMatch(/only thing that sends data off this Mac/i);
    expect(el?.querySelector("button[aria-expanded]")).toBeNull();
  });

  it("carries the badge", () => {
    renderPane(<IntegrationsPane />);
    expect(screen.getAllByText(/leaves this Mac/i).length).toBeGreaterThan(0);
  });

  it("still says a summary only is sent, and that logs are not", () => {
    const { container } = renderPane(<IntegrationsPane />);
    const el = container.querySelector('[data-setting-row="alert-webhook-enabled"]');
    expect(el?.textContent).toMatch(/summary only/i);
    expect(el?.textContent).toMatch(/Run logs are never included/i);
  });

  it("keeps the Claude caveat that the 2026-08-06 correction added", () => {
    // The copy once claimed webhooks were "the only feature that sends anything
    // off this Mac". That is false — Debug with AI on the Claude provider sends
    // the script and the failing run's output to Anthropic. A reader could
    // otherwise conclude their run logs never leave. See docs/DECISIONS.md.
    const { container } = renderPane(<IntegrationsPane />);
    const el = container.querySelector('[data-setting-row="alert-webhook-enabled"]');
    expect(el?.textContent).toMatch(/Anthropic/);
    expect(el?.textContent).toMatch(/only when you click it/i);
  });

  it("says Linear is never sent to on its own, with nothing to click open", () => {
    // Both rows carry the "leaves this Mac" badge, but they mean different
    // things: the webhook sends automatically, Linear only when you press a
    // button. Without the distinction on screen the pane reads as two
    // background senders.
    //
    // The second assertion is the one that would have caught the original bug
    // here: this sentence was written as `details`, and `SettingRow` silently
    // DROPS details on a flagged row — so the copy existed, type-checked, and
    // rendered nowhere.
    renderPane(<IntegrationsPane />);
    const el = row("linear-connection");
    expect(el.textContent).toMatch(/always something you click/i);
    expect(el.querySelector("button[aria-expanded]")).toBeNull();
  });
});

describe("the GitHub token", () => {
  it("is masked and write-only", () => {
    renderPane(<IntegrationsPane />);
    expect(fieldById("github-token").getAttribute("type")).toBe("password");
  });

  it("hands the token over and then clears the field", async () => {
    const { controller } = renderPane(<IntegrationsPane />);
    const field = fieldById("github-token");
    fireEvent.change(field, { target: { value: "ghp_SECRETVALUE" } });
    fireEvent.click(screen.getByRole("button", { name: /save github token/i }));

    await waitFor(() => expect(controller.saveGithubToken).toHaveBeenCalledTimes(1));
    expect(controller.saveGithubToken).toHaveBeenCalledWith("ghp_SECRETVALUE");
    await waitFor(() => expect(field.value).toBe(""));
  });

  it("says it is optional when none is stored", () => {
    // The branch switcher works without one. Copy that implied otherwise would
    // push people into creating a credential they don't need.
    renderPane(<IntegrationsPane />);
    expect(row("github-token").textContent).toMatch(/optional/i);
  });

  it("offers Remove only once stored", () => {
    const { unmount } = renderPane(<IntegrationsPane />);
    expect(screen.queryByRole("button", { name: /remove github token/i })).toBeNull();
    unmount();

    renderPane(<IntegrationsPane />, { controller: makeController({ hasGithubToken: true }) });
    expect(screen.getByRole("button", { name: /remove github token/i })).toBeTruthy();
  });

  it("clears the stored token", async () => {
    const controller = makeController({ hasGithubToken: true });
    renderPane(<IntegrationsPane />, { controller });
    fireEvent.click(screen.getByRole("button", { name: /remove github token/i }));
    await waitFor(() => expect(controller.clearGithubToken).toHaveBeenCalledTimes(1));
  });
});

describe("search filtering", () => {
  it("hides the rows that did not match", () => {
    renderPane(<IntegrationsPane />, { matchedIds: ["github-token"] });
    expect(fieldById("github-token")).toBeTruthy();
    expect(queryField("alert-webhook-url")).toBeNull();
  });

  it("keeps the credential rows reachable by search", () => {
    renderPane(<IntegrationsPane />, { matchedIds: ["alert-webhook-url"] });
    expect(fieldById("alert-webhook-url")).toBeTruthy();
  });
});

describe("counting destinations uses the provider's own plural", () => {
  it("does not invent one by appending an s", () => {
    // "3 repositorys" shipped the first time this pane saw a container word
    // other than "Team". English has no rule a caller can apply, so the
    // provider that names the container names its plural too.
    const controller = connected({
      issuesVocabulary: {
        name: "GitHub",
        container: "Repository",
        containerPlural: "Repositories",
        subContainer: "Milestone",
        keyHelpUrl: "https://github.com/settings/tokens",
        keyPlaceholder: "ghp_…",
        supportsImageUpload: false,
      },
      issueContainers: [
        { id: "acme/one", name: "one", key: "acme" },
        { id: "acme/two", name: "two", key: "acme" },
      ],
    });
    renderPane(<IntegrationsPane />, { controller });
    expect(row("linear-default-team").textContent).toMatch(/2 repositories available/i);
    expect(row("linear-default-team").textContent).not.toMatch(/repositorys/i);
  });

  it("still uses the singular for one", () => {
    const controller = connected({
      issueContainers: [{ id: "team-eng", name: "Engineering", key: "ENG" }],
    });
    renderPane(<IntegrationsPane />, { controller });
    expect(row("linear-default-team").textContent).toMatch(/1 team available/i);
  });
});

// ── Shopify crawler signatures ────────────────────────────────────────
//
// The row's job is to answer "why did my crawl start failing?", and it can only
// do that if the two BAD states are distinguishable from each other and from
// "nothing configured". An expired signature and one that cannot be decrypted
// need different actions — create a new one in the admin, versus re-paste the
// one you have — so a row that rendered them the same would send half its
// readers to the wrong place.

const NOW_MS = Date.UTC(2026, 7, 18);
const NOW_S = Math.floor(NOW_MS / 1000);
const DAY_S = 24 * 60 * 60;

function signature(over: Partial<ShopifySignatureStatus> = {}): ShopifySignatureStatus {
  return {
    id: "sig-1",
    host: "shop.example.com",
    expiresAt: NOW_S + 60 * DAY_S,
    createdAt: NOW_S - DAY_S,
    addedAt: NOW_MS,
    state: "valid",
    ...over,
  };
}

/** Type into the three fields of the add form. */
function fillSignatureForm(scope: HTMLElement, host: string, input: string, value: string): void {
  fireEvent.change(fieldById("shopify-signatures"), { target: { value: host } });
  fireEvent.change(within(scope).getByLabelText("Signature-Input"), { target: { value: input } });
  fireEvent.change(within(scope).getByLabelText("Signature"), { target: { value } });
}

describe("the Shopify signature row", () => {
  it("masks both secret fields so a pasted signature isn't shoulder-readable", () => {
    renderPane(<IntegrationsPane />);
    const scope = row("shopify-signatures");
    // The domain is deliberately NOT masked: it is the field most likely to be
    // wrong, and a signature at the wrong authority is worse than none. Asserted
    // on the PROPERTY — React omits the attribute entirely for a default-type
    // input, so `getAttribute("type")` is null here rather than "text".
    expect(fieldById("shopify-signatures").type).toBe("text");
    expect(within(scope).getByLabelText("Signature-Input").getAttribute("type")).toBe("password");
    expect(within(scope).getByLabelText("Signature").getAttribute("type")).toBe("password");
  });

  it("sends all three values to the backend on save", () => {
    const addSignature = vi.fn(async () => true);
    renderPane(<IntegrationsPane />, { controller: makeController({ addSignature }) });
    const scope = row("shopify-signatures");
    fillSignatureForm(scope, "shop.example.com", 'sig1=("@authority");expires=1', "sig1=:abc:");
    fireEvent.click(within(scope).getByRole("button", { name: /save shopify signature/i }));
    expect(addSignature).toHaveBeenCalledWith({
      host: "shop.example.com",
      signatureInput: 'sig1=("@authority");expires=1',
      signature: "sig1=:abc:",
    });
  });

  it("cannot be saved until all three fields are filled", () => {
    renderPane(<IntegrationsPane />);
    const scope = row("shopify-signatures");
    const save = within(scope).getByRole("button", {
      name: /save shopify signature/i,
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fillSignatureForm(scope, "shop.example.com", "sig1=(...)", "");
    expect(save.disabled).toBe(true);
    fillSignatureForm(scope, "shop.example.com", "sig1=(...)", "sig1=:abc:");
    expect(save.disabled).toBe(false);
  });

  it("keeps the paste when the save is refused", async () => {
    // A signature is a long paste out of another window. Clearing on failure
    // would mean a typo'd domain costs a trip back to the Shopify admin.
    renderPane(<IntegrationsPane />, {
      controller: makeController({ addSignature: vi.fn(async () => false) }),
    });
    const scope = row("shopify-signatures");
    const value = within(scope).getByLabelText("Signature") as HTMLInputElement;
    fillSignatureForm(scope, "nope", "a", "sig1=:keep-me:");
    fireEvent.click(within(scope).getByRole("button", { name: /save shopify signature/i }));
    await waitFor(() => expect(value.value).toBe("sig1=:keep-me:"));
  });

  it("clears the fields once the signature is saved", async () => {
    renderPane(<IntegrationsPane />, {
      controller: makeController({ addSignature: vi.fn(async () => true) }),
    });
    const scope = row("shopify-signatures");
    const value = within(scope).getByLabelText("Signature") as HTMLInputElement;
    fillSignatureForm(scope, "shop.example.com", "a", "sig1=:abc:");
    fireEvent.click(within(scope).getByRole("button", { name: /save shopify signature/i }));
    await waitFor(() => expect(value.value).toBe(""));
  });

  it("renders each state as its own claim", () => {
    // `vi.setSystemTime`, not `process.env.TZ` — see the CLAUDE.md gotcha. The
    // clock has to be fixed because four of these five labels are relative.
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      renderPane(<IntegrationsPane />, {
        controller: makeController({
          signatures: [
            signature({ id: "a", host: "valid.example.com" }),
            signature({
              id: "b",
              host: "soon.example.com",
              state: "expiring",
              expiresAt: NOW_S + 3 * DAY_S,
            }),
            signature({
              id: "c",
              host: "gone.example.com",
              state: "expired",
              // NOON UTC on the 17th, not midnight. The date is rendered in the
              // reader's own zone, so a midnight-UTC expiry reads as the 16th
              // anywhere west of Greenwich and the assertion below would pin
              // the test to the machine that wrote it.
              expiresAt: NOW_S - DAY_S + 12 * 60 * 60,
            }),
            signature({ id: "d", host: "locked.example.com", state: "unreadable" }),
            signature({
              id: "e",
              host: "nodate.example.com",
              state: "unknown",
              expiresAt: null,
            }),
          ],
        }),
      });
      const scope = row("shopify-signatures");
      expect(within(scope).getByText(/Valid — expires in 60 days/)).toBeTruthy();
      expect(within(scope).getByText(/^Expires in 3 days$/)).toBeTruthy();
      // Locale-agnostic: the date is formatted for whoever is looking, and
      // pinning en-US here would fail on a machine set to anything else.
      const expired = within(scope).getByText(/^Expired on /);
      expect(expired.textContent).toMatch(/17/);
      expect(expired.textContent).toMatch(/2026/);
      // Never collapsed into "nothing configured" — the user registered this
      // one, and a pane that said nothing would be why they never find out that
      // their crawl is running unsigned.
      expect(within(scope).getByText(/unreadable on this Mac/i)).toBeTruthy();
      expect(within(scope).getByText(/Expiry unknown/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers Remove per host, naming which one", () => {
    const removeSignature = vi.fn(async () => {});
    renderPane(<IntegrationsPane />, {
      controller: makeController({
        signatures: [
          signature({ id: "a", host: "keep.example.com" }),
          signature({ id: "b", host: "gone.example.com", state: "expired", expiresAt: NOW_S - 1 }),
        ],
        removeSignature,
      }),
    });
    const scope = row("shopify-signatures");
    // An expired row keeps its place rather than vanishing: the row saying
    // "expired" is how the user learns why the crawl started failing.
    fireEvent.click(
      within(scope).getByRole("button", { name: /remove the signature for gone\.example\.com/i }),
    );
    expect(removeSignature).toHaveBeenCalledWith("b");
  });

  it("says what leaves this Mac and where it goes", () => {
    // The pane's subject is what this app talks to, so the row states its own
    // egress rather than leaving it to the docs.
    renderPane(<IntegrationsPane />);
    const scope = row("shopify-signatures");
    expect(scope.textContent).toMatch(/stored encrypted on this Mac/i);
    expect(scope.textContent).toMatch(/sent only to the domain they name/i);
    expect(scope.textContent).toMatch(/bound to a single domain/i);
  });
});
