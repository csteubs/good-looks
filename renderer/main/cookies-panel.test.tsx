// Component tests for the trainer's Cookies panel.
//
// The panel does two separable things per interaction — mutate the training
// browser AND (optionally) record a test step — and the separation is the whole
// design. Getting it wrong in either direction is a real bug: always recording
// bakes an expiring auth token into the committed spec; never recording leaves
// a test that passes in the trainer and fails on a run.
//
// Also covers the expiry control, which was missing entirely at first: without
// it every cookie created here was silently a session cookie.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

import type { CookieSpec, LiveCookie, RawStep } from "../lib/recorder-types";
import { CookiesPanel } from "./cookies-panel";

let live: LiveCookie[] = [];
const setCookie = vi.fn(async (_c: CookieSpec) => live);
const deleteCookie = vi.fn(async (_c: CookieSpec) => live);
const clearCookies = vi.fn(async () => [] as LiveCookie[]);

vi.mock("../lib/api", () => ({
  api: {
    recorder: {
      listCookies: async () => live,
      setCookie: (c: CookieSpec) => setCookie(c),
      deleteCookie: (c: CookieSpec) => deleteCookie(c),
      clearCookies: () => clearCookies(),
    },
  },
}));

function renderPanel() {
  const onInsertStep = vi.fn((_s: RawStep) => {});
  render(<CookiesPanel onInsertStep={onInsertStep} />);
  return { onInsertStep };
}

/** Fill the add-cookie form. */
function fillForm(name: string, value: string) {
  fireEvent.change(screen.getByLabelText("Cookie name"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("Cookie value"), { target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
  live = [];
});

describe("listing", () => {
  it("says so when the page has no cookies", async () => {
    renderPanel();
    expect(await screen.findByText(/no cookies for this page/i)).toBeTruthy();
  });

  it("lists existing cookies with their flags", async () => {
    live = [
      { name: "session", value: "abc", domain: "example.com", path: "/", httpOnly: true, secure: true },
    ];
    renderPanel();
    expect(await screen.findByText(/1 cookie for this page/i)).toBeTruthy();
    // Scoped to the cookie's ROW: "HttpOnly"/"Secure" also label the form's
    // checkboxes, so an unscoped query is ambiguous.
    const row = screen.getByTitle("session=abc").closest("div")!;
    expect(within(row).getByText("HttpOnly")).toBeTruthy();
    expect(within(row).getByText("Secure")).toBeTruthy();
  });

  it("shows a cookie with no expiry as a session cookie", async () => {
    live = [{ name: "s", value: "1", domain: "x.test", path: "/", session: true }];
    renderPanel();
    expect(await screen.findByText("session")).toBeTruthy();
  });
});

describe("creating a cookie", () => {
  it("sets it on the training browser", async () => {
    renderPanel();
    await screen.findByText(/no cookies/i);

    fillForm("session", "abc123");
    fireEvent.click(screen.getByRole("button", { name: /add cookie/i }));

    await waitFor(() => expect(setCookie).toHaveBeenCalledTimes(1));
    expect(setCookie.mock.calls[0][0]).toMatchObject({ name: "session", value: "abc123" });
  });

  it("also records a step while 'Add to test as a step' is ticked", async () => {
    const { onInsertStep } = renderPanel();
    await screen.findByText(/no cookies/i);

    fillForm("session", "abc123");
    fireEvent.click(screen.getByRole("button", { name: /add cookie/i }));

    await waitFor(() => expect(onInsertStep).toHaveBeenCalledTimes(1));
    expect(onInsertStep.mock.calls[0][0]).toMatchObject({
      type: "cookie",
      cookieAction: "set",
    });
  });

  it("does NOT record a step when the box is unticked", async () => {
    // The opt-out matters: recording would put an expiring token in the spec.
    const { onInsertStep } = renderPanel();
    await screen.findByText(/no cookies/i);

    fireEvent.click(screen.getByLabelText(/also add cookie changes/i));
    fillForm("session", "abc123");
    fireEvent.click(screen.getByRole("button", { name: /add cookie/i }));

    await waitFor(() => expect(setCookie).toHaveBeenCalled());
    expect(onInsertStep).not.toHaveBeenCalled();
  });

  it("refuses a nameless cookie without calling the backend", async () => {
    renderPanel();
    await screen.findByText(/no cookies/i);
    fireEvent.click(screen.getByRole("button", { name: /add cookie/i }));
    await waitFor(() => expect(screen.queryByText(/no cookies/i)).toBeTruthy());
    expect(setCookie).not.toHaveBeenCalled();
  });

  it("passes httpOnly through — the reason this uses the session API at all", async () => {
    renderPanel();
    await screen.findByText(/no cookies/i);

    fillForm("session", "abc");
    fireEvent.click(screen.getByLabelText("HttpOnly"));
    fireEvent.click(screen.getByRole("button", { name: /add cookie/i }));

    await waitFor(() => expect(setCookie).toHaveBeenCalled());
    expect(setCookie.mock.calls[0][0].httpOnly).toBe(true);
  });
});

describe("expiry", () => {
  it("creates a session cookie by default", async () => {
    renderPanel();
    await screen.findByText(/no cookies/i);

    // "Session" starts ticked, so no expiry field is shown.
    expect(screen.queryByLabelText("Cookie expiry")).toBeNull();

    fillForm("s", "1");
    fireEvent.click(screen.getByRole("button", { name: /add cookie/i }));
    await waitFor(() => expect(setCookie).toHaveBeenCalled());
    expect(setCookie.mock.calls[0][0].expirationDate).toBeUndefined();
  });

  it("reveals a date field and sends an expiry when Session is unticked", async () => {
    // Without this control every cookie created here was silently a session
    // cookie — invisible until a test failed after a browser restart.
    renderPanel();
    await screen.findByText(/no cookies/i);

    fireEvent.click(screen.getByLabelText(/session cookie/i));
    const field = await screen.findByLabelText("Cookie expiry");
    expect(field).toBeTruthy();

    fillForm("s", "1");
    fireEvent.click(screen.getByRole("button", { name: /add cookie/i }));

    await waitFor(() => expect(setCookie).toHaveBeenCalled());
    expect(typeof setCookie.mock.calls[0][0].expirationDate).toBe("number");
  });
});

describe("deleting", () => {
  it("deletes a cookie and records a delete step", async () => {
    live = [{ name: "session", value: "abc", domain: "example.com", path: "/" }];
    const { onInsertStep } = renderPanel();
    await screen.findByText(/1 cookie/i);

    fireEvent.click(screen.getByLabelText("Delete cookie session"));

    await waitFor(() => expect(deleteCookie).toHaveBeenCalledTimes(1));
    expect(deleteCookie.mock.calls[0][0]).toMatchObject({ name: "session", domain: "example.com" });
    expect(onInsertStep.mock.calls[0][0]).toMatchObject({
      type: "cookie",
      cookieAction: "delete",
    });
  });

  it("clears everything and records a clearAll step", async () => {
    live = [{ name: "a", value: "1", domain: "x.test", path: "/" }];
    const { onInsertStep } = renderPanel();
    await screen.findByText(/1 cookie/i);

    fireEvent.click(screen.getByRole("button", { name: /clear all cookies/i }));

    await waitFor(() => expect(clearCookies).toHaveBeenCalledTimes(1));
    expect(onInsertStep.mock.calls[0][0]).toMatchObject({
      type: "cookie",
      cookieAction: "clearAll",
    });
  });
});

describe("editing", () => {
  it("loads a cookie into the form when clicked", async () => {
    live = [{ name: "session", value: "abc", domain: "example.com", path: "/" }];
    renderPanel();
    await screen.findByText(/1 cookie/i);

    fireEvent.click(screen.getByTitle("session=abc"));

    await waitFor(() =>
      expect((screen.getByLabelText("Cookie name") as HTMLInputElement).value).toBe("session"),
    );
    expect((screen.getByLabelText("Cookie value") as HTMLInputElement).value).toBe("abc");
  });
});
