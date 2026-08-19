// Tests for the Proxy pane.
//
// The rows are ordinary settings rows, so what is pinned here is what is
// specific to this pane: the manual rows unmount in automatic mode (the
// dependent-row rule), the URL field refuses what the store would refuse —
// especially credentials, whose whole storage story is that they do NOT go in
// the plain settings file — the password is write-only with the MCP
// limitation disclosed in always-visible copy, and the validate dialog
// renders a failure as an answer rather than as a broken control.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";

import { clearToastCalls, toastTexts } from "../../__tests__/sonner-stub";
import { SETTINGS_DEFAULTS } from "../../lib/settings-schema";
import { makeController, renderPane, savedPatch } from "../__tests__/harness";
import { ProxyPane } from "./proxy-pane";

// Mocked per the house rule — the api module, never the IPC bridge.
const { proxyApi } = vi.hoisted(() => ({
  proxyApi: {
    hasPassword: vi.fn(async () => ({ hasPassword: false })),
    setPassword: vi.fn(async () => ({ hasPassword: true })),
    clearPassword: vi.fn(async () => ({ hasPassword: false })),
    verifyApp: vi.fn(async () => ({
      ok: true,
      url: "https://api.anthropic.com",
      via: "proxy http://proxy.corp:8080",
      detail: "Reached api.anthropic.com (HTTP 401, proxy http://proxy.corp:8080).",
    })),
    verifyTest: vi.fn(async () => ({
      ok: false,
      url: "https://staging.example.com",
      via: "proxy http://proxy.corp:8080",
      detail: "ERR_TUNNEL_CONNECTION_FAILED — could not connect through the proxy.",
    })),
  },
}));
vi.mock("../../lib/api", () => ({ api: { proxy: proxyApi } }));

beforeEach(() => {
  vi.clearAllMocks();
  clearToastCalls();
});

/** A controller already in manual mode with a URL saved — the state every
 *  credential-row test starts from. */
function manualController(over: Record<string, unknown> = {}) {
  return makeController({
    settings: {
      ...SETTINGS_DEFAULTS,
      proxyTraffic: "both",
      proxySource: "manual",
      proxyUrl: "http://proxy.corp:8080",
      ...over,
    },
  });
}

/** Drive the native-menu-backed Select — same scaffolding as the typeface
 *  test, and justified the same way: choosing a traffic class is the pane's
 *  primary action, and the options never enter the DOM. */
function chooseFromNativeMenu(triggerId: string, label: string): void {
  interface Item {
    label?: string;
    commandId?: number;
    submenu?: Item[];
  }
  const popup = vi.fn(async ({ items }: { items: Item[] }) => {
    const flat: Item[] = [];
    const walk = (list: Item[]): void => {
      for (const i of list) {
        flat.push(i);
        if (i.submenu) walk(i.submenu);
      }
    };
    walk(items);
    const hit = flat.find((i) => i.label === label && i.commandId !== undefined);
    if (!hit) {
      throw new Error(`no menu item labelled "${label}" (saw: ${flat.map((i) => i.label).join(", ")})`);
    }
    return { commandId: hit.commandId };
  });
  (window as unknown as { glazeAPI: { Menu: unknown } }).glazeAPI = { Menu: { popup } };
  fireEvent.click(document.getElementById(triggerId) as HTMLElement);
}

describe("defaults and dependency", () => {
  it("ships inert: traffic None, source Automatic, no manual rows", () => {
    renderPane(<ProxyPane />);
    // Asserted on the trigger's own text — "automatic" also appears in the
    // source row's summary, so a bare getByText is ambiguous.
    expect(document.getElementById("proxy-traffic")?.textContent).toContain("None");
    expect(document.getElementById("proxy-source")?.textContent).toContain("Automatic");
    // Unmounted, not greyed — the dependent-row rule. A URL field that saves
    // into a mode nothing reads would be a control that looks live and isn't.
    expect(screen.queryByLabelText("Proxy URL")).toBeNull();
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(screen.queryByLabelText(/^password/i)).toBeNull();
    expect(screen.queryByRole("switch", { name: /ssl verify/i })).toBeNull();
  });

  it("manual mode mounts the URL, credential and SSL rows", () => {
    renderPane(<ProxyPane />, { controller: manualController() });
    expect(screen.getByLabelText("Proxy URL")).toBeTruthy();
    expect(screen.getByLabelText("Username")).toBeTruthy();
    expect(screen.getByLabelText(/^password/i)).toBeTruthy();
    expect(screen.getByRole("switch", { name: /ssl verify/i })).toBeTruthy();
  });

  it("saves a traffic choice through the native menu", async () => {
    const controller = makeController();
    renderPane(<ProxyPane />, { controller });
    chooseFromNativeMenu("proxy-traffic", "Test");
    await waitFor(() => expect(savedPatch(controller)).toEqual({ proxyTraffic: "test" }));
  });

  it("saves a source choice through the native menu", async () => {
    const controller = makeController();
    renderPane(<ProxyPane />, { controller });
    chooseFromNativeMenu("proxy-source", "Manual");
    await waitFor(() => expect(savedPatch(controller)).toEqual({ proxySource: "manual" }));
  });
});

describe("the proxy URL field", () => {
  it("commits a valid URL on blur, canonicalised", () => {
    const controller = manualController({ proxyUrl: "" });
    renderPane(<ProxyPane />, { controller });
    const input = screen.getByLabelText("Proxy URL");
    fireEvent.change(input, { target: { value: "https://proxy.corp:3128/" } });
    fireEvent.blur(input);
    expect(savedPatch(controller)).toEqual({ proxyUrl: "https://proxy.corp:3128" });
  });

  it("refuses credentials in the URL and says where they go instead", () => {
    const controller = manualController();
    renderPane(<ProxyPane />, { controller });
    const input = screen.getByLabelText("Proxy URL");
    fireEvent.change(input, { target: { value: "http://user:pw@proxy.corp:8080" } });
    fireEvent.blur(input);
    expect(controller.save).not.toHaveBeenCalled();
    expect(toastTexts().some((t) => /username and password fields/i.test(t.title))).toBe(true);
    // The draft survives the rejection — wiping it gives nothing to correct.
    expect((input as HTMLInputElement).value).toBe("http://user:pw@proxy.corp:8080");
  });

  it("refuses a scheme nothing downstream can drive", () => {
    const controller = manualController();
    renderPane(<ProxyPane />, { controller });
    const input = screen.getByLabelText("Proxy URL");
    fireEvent.change(input, { target: { value: "ftp://proxy.corp:21" } });
    fireEvent.blur(input);
    expect(controller.save).not.toHaveBeenCalled();
    expect(toastTexts().some((t) => /http:\/\/, https:\/\/ or socks5:\/\//i.test(t.title))).toBe(true);
  });

  it("lets an empty field clear the URL", () => {
    const controller = manualController();
    renderPane(<ProxyPane />, { controller });
    const input = screen.getByLabelText("Proxy URL");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(savedPatch(controller)).toEqual({ proxyUrl: "" });
  });
});

describe("the password row", () => {
  it("is write-only, and its always-visible copy discloses the MCP limitation", () => {
    renderPane(<ProxyPane />, { controller: manualController() });
    const input = screen.getByLabelText(/^password/i) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    // In summary, not behind a disclosure: the row is flagged, so SettingRow
    // structurally cannot hide this behind "More".
    expect(screen.getByText(/MCP server can't decrypt it/i)).toBeTruthy();
  });

  it("saves a typed password and clears the field", async () => {
    renderPane(<ProxyPane />, { controller: manualController() });
    const input = screen.getByLabelText(/^password/i) as HTMLInputElement;
    const saveButton = screen.getByRole("button", { name: /save proxy password/i });
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "s3cret" } });
    fireEvent.click(saveButton);
    await waitFor(() => expect(proxyApi.setPassword).toHaveBeenCalledWith("s3cret"));
    await waitFor(() => expect(input.value).toBe(""));
    // The saved state is reflected, without the value ever coming back.
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove proxy password/i })).toBeTruthy();
  });

  it("offers Remove only once a password exists", async () => {
    proxyApi.hasPassword.mockResolvedValueOnce({ hasPassword: true });
    renderPane(<ProxyPane />, { controller: manualController() });
    const remove = await screen.findByRole("button", { name: /remove proxy password/i });
    fireEvent.click(remove);
    await waitFor(() => expect(proxyApi.clearPassword).toHaveBeenCalled());
  });
});

describe("SSL Verify", () => {
  it("saves the toggle", () => {
    const controller = manualController();
    renderPane(<ProxyPane />, { controller });
    fireEvent.click(screen.getByRole("switch", { name: /ssl verify/i }));
    expect(savedPatch(controller)).toEqual({ proxySslVerify: false });
  });

  it("shows the risk block only while verification is off", () => {
    const { unmount } = renderPane(<ProxyPane />, { controller: manualController() });
    expect(screen.queryByText(/read and rewrite that traffic/i)).toBeNull();
    unmount();
    renderPane(<ProxyPane />, { controller: manualController({ proxySslVerify: false }) });
    expect(screen.getByText(/read and rewrite that traffic/i)).toBeTruthy();
  });
});

describe("the validate dialog", () => {
  it("verifies app connectivity and renders the reachable answer with its path", async () => {
    renderPane(<ProxyPane />, { controller: manualController() });
    fireEvent.click(screen.getByRole("button", { name: /validate proxy settings/i }));
    fireEvent.click(await screen.findByRole("button", { name: /verify app connectivity/i }));
    await waitFor(() => expect(proxyApi.verifyApp).toHaveBeenCalled());
    expect(await screen.findByText(/Reached api.anthropic.com/)).toBeTruthy();
    // The path is part of the answer: a green check that silently went direct
    // would tell the user their proxy works when it was never in the path.
    expect(screen.getByText(/Checked https:\/\/api.anthropic.com — proxy/)).toBeTruthy();
  });

  it("renders a failed test-traffic check as the answer, not an error state", async () => {
    renderPane(<ProxyPane />, { controller: manualController() });
    fireEvent.click(screen.getByRole("button", { name: /validate proxy settings/i }));
    const urlInput = await screen.findByLabelText("URL to test");
    fireEvent.change(urlInput, { target: { value: "https://staging.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /verify test connectivity/i }));
    await waitFor(() =>
      expect(proxyApi.verifyTest).toHaveBeenCalledWith("https://staging.example.com"),
    );
    expect(await screen.findByText("Failed")).toBeTruthy();
    expect(screen.getByText(/ERR_TUNNEL_CONNECTION_FAILED/)).toBeTruthy();
  });

  it("says which traffic classes the settings currently apply to", async () => {
    renderPane(<ProxyPane />, {
      controller: manualController({ proxyTraffic: "test" }),
    });
    fireEvent.click(screen.getByRole("button", { name: /validate proxy settings/i }));
    expect(await screen.findByText(/App traffic — proxy settings do not apply/)).toBeTruthy();
    expect(screen.getByText(/Test traffic — proxy settings apply/)).toBeTruthy();
    // mabl's own caveat, kept: a validation is not a run.
    expect(screen.getByText(/can behave differently from a real run/i)).toBeTruthy();
  });
});
