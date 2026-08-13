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

import { describe, it, expect } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";

import { makeController, renderPane, savedPatch } from "../__tests__/harness";
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
