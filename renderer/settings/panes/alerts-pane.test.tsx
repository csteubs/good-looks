// Tests for the Alerts pane.
//
// The webhook URL is a bearer credential — anyone holding a Slack webhook URL
// can post to that channel — so it is write-only by design: the backend stores
// it encrypted and hands back only `{hasUrl, host}`. These tests assert on what
// CROSSES the boundary and on what reaches the screen, not just on what
// renders. They were carried over from the pre-redesign `settings-view.test.tsx`
// and must keep holding.

import { describe, it, expect } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";

import { makeController, renderPane, savedPatch } from "../__tests__/harness";
import { AlertsPane } from "./alerts-pane";

describe("local notifications", () => {
  it("saves the toggle", () => {
    const { controller } = renderPane(<AlertsPane />);
    fireEvent.click(screen.getByRole("switch", { name: /notify when a run has problems/i }));
    expect(savedPatch(controller)).toEqual({ notifyOnRunIssues: true });
  });

  it("says the notification never leaves the Mac", () => {
    // The distinction from the webhook row below is the whole reason these two
    // sit next to each other.
    renderPane(<AlertsPane />);
    fireEvent.click(screen.getByRole("button", { name: /more/i }));
    expect(screen.getByText(/local to this Mac/i)).toBeTruthy();
  });
});

describe("the alert webhook is write-only", () => {
  it("keeps the enable switch disabled until a URL is configured", () => {
    // Enabling alerts with no destination would silently do nothing.
    renderPane(<AlertsPane />);
    const sw = screen.getByRole("switch", { name: /send alerts to a webhook/i });
    expect(sw.getAttribute("data-disabled") ?? sw.getAttribute("disabled")).not.toBeNull();
  });

  it("enables the switch once a URL exists", () => {
    const controller = makeController({
      webhookStatus: { hasUrl: true, host: "hooks.example.com" },
    });
    renderPane(<AlertsPane />, { controller });
    const sw = screen.getByRole("switch", { name: /send alerts to a webhook/i });
    expect(sw.getAttribute("data-disabled") ?? sw.getAttribute("disabled")).toBeNull();
  });

  it("saves a pasted URL and then clears the field", async () => {
    const { controller } = renderPane(<AlertsPane />);
    const field = screen.getByLabelText(/webhook url/i) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "https://hooks.example.com/services/SECRET" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(controller.saveWebhookUrl).toHaveBeenCalledTimes(1));
    expect(controller.saveWebhookUrl).toHaveBeenCalledWith(
      "https://hooks.example.com/services/SECRET",
    );
    // Cleared after saving: the URL is a bearer credential and must not linger
    // on screen.
    await waitFor(() => expect(field.value).toBe(""));
  });

  it("keeps what was typed when the save is rejected", () => {
    // Wiping the field on failure loses the URL and gives the user nothing to
    // correct — they'd have to go back to Slack for it.
    const controller = makeController({ saveWebhookUrl: async () => false });
    renderPane(<AlertsPane />, { controller });
    const field = screen.getByLabelText(/webhook url/i) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "not-a-url" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(field.value).toBe("not-a-url");
  });

  it("never renders the stored URL — only its host", () => {
    const controller = makeController({
      webhookStatus: { hasUrl: true, host: "hooks.example.com" },
    });
    renderPane(<AlertsPane />, { controller });
    expect(screen.getByText(/hooks\.example\.com/)).toBeTruthy();
    // The backend never returns the URL; assert nothing resembling a token is
    // on screen either.
    expect(document.body.textContent).not.toMatch(/services\/SECRET/);
  });

  it("masks the input so a pasted credential isn't shoulder-readable", () => {
    renderPane(<AlertsPane />);
    expect(screen.getByLabelText(/webhook url/i).getAttribute("type")).toBe("password");
  });

  it("offers Send test and Remove only once configured", () => {
    const { unmount } = renderPane(<AlertsPane />);
    expect(screen.queryByRole("button", { name: /send test/i })).toBeNull();
    unmount();

    const controller = makeController({
      webhookStatus: { hasUrl: true, host: "hooks.example.com" },
    });
    renderPane(<AlertsPane />, { controller });
    expect(screen.getByRole("button", { name: /send test/i })).toBeTruthy();
  });

  it("clears the stored URL", async () => {
    const controller = makeController({
      webhookStatus: { hasUrl: true, host: "hooks.example.com" },
    });
    renderPane(<AlertsPane />, { controller });
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    await waitFor(() => expect(controller.clearWebhookUrl).toHaveBeenCalledTimes(1));
  });

  it("sends a test alert", async () => {
    const controller = makeController({
      webhookStatus: { hasUrl: true, host: "hooks.example.com" },
    });
    renderPane(<AlertsPane />, { controller });
    fireEvent.click(screen.getByRole("button", { name: /send test/i }));
    await waitFor(() => expect(controller.testWebhook).toHaveBeenCalledTimes(1));
  });

  it("refuses to save an empty field", () => {
    renderPane(<AlertsPane />);
    expect(
      (screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("disables its controls while a webhook call is in flight", () => {
    // Two saves racing would leave the stored URL and the displayed host
    // disagreeing about which one won.
    const controller = makeController({
      webhookBusy: true,
      webhookStatus: { hasUrl: true, host: "hooks.example.com" },
    });
    renderPane(<AlertsPane />, { controller });
    expect((screen.getByRole("button", { name: /send test/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: /remove/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("saves the enable toggle once a URL exists", () => {
    const controller = makeController({
      webhookStatus: { hasUrl: true, host: "hooks.example.com" },
    });
    renderPane(<AlertsPane />, { controller });
    fireEvent.click(screen.getByRole("switch", { name: /send alerts to a webhook/i }));
    expect(savedPatch(controller)).toEqual({ alertWebhookEnabled: true });
  });
});

describe("the off-this-Mac warning", () => {
  it("is on screen with no disclosure to open", () => {
    // This is the only thing in the app that sends data off the Mac
    // automatically. Behind a "More" link, most users never read it.
    const { container } = renderPane(<AlertsPane />);
    const row = container.querySelector('[data-setting-row="alert-webhook-enabled"]');
    expect(row?.textContent).toMatch(/only thing that sends data off this Mac/i);
    expect(row?.querySelector("button[aria-expanded]")).toBeNull();
  });

  it("carries the badge", () => {
    renderPane(<AlertsPane />);
    expect(screen.getByText(/leaves this Mac/i)).toBeTruthy();
  });

  it("still says a summary only is sent, and that logs are not", () => {
    const { container } = renderPane(<AlertsPane />);
    const row = container.querySelector('[data-setting-row="alert-webhook-enabled"]');
    expect(row?.textContent).toMatch(/summary only/i);
    expect(row?.textContent).toMatch(/Run logs are never included/i);
  });

  it("keeps the Claude caveat that the 2026-08-06 correction added", () => {
    // The copy once claimed webhooks were "the only feature that sends anything
    // off this Mac". That is false — Debug with AI on the Claude provider sends
    // the script and the failing run's output to Anthropic. A reader could
    // otherwise conclude their run logs never leave. See docs/DECISIONS.md.
    const { container } = renderPane(<AlertsPane />);
    const row = container.querySelector('[data-setting-row="alert-webhook-enabled"]');
    expect(row?.textContent).toMatch(/Anthropic/);
    expect(row?.textContent).toMatch(/only when you click it/i);
  });
});

describe("search filtering", () => {
  it("hides the URL row when only the notification row matched", () => {
    renderPane(<AlertsPane />, { matchedIds: ["notify-run-issues"] });
    expect(screen.getByRole("switch", { name: /notify when a run has problems/i })).toBeTruthy();
    expect(screen.queryByLabelText(/webhook url/i)).toBeNull();
  });

  it("keeps the credential row reachable by search", () => {
    renderPane(<AlertsPane />, { matchedIds: ["alert-webhook-url"] });
    expect(screen.getByLabelText(/webhook url/i)).toBeTruthy();
  });
});
