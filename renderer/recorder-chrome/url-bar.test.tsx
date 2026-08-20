// The training browser's URL bar.
//
// What is worth testing here is narrow but load-bearing: this component exists
// because the thing it replaced LIED. The old URL bar was the native window
// title, and Electron's default handling of `page-title-updated` overwrote it
// with the site's own `document.title` on every load — so the trainer showed
// "Ritual" where it meant to show the URL, and the user had to open a different
// browser to read where they were. A bar that renders the wrong string, or
// silently renders nothing, puts them straight back there.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { UrlBar, splitForDisplay } from "./url-bar";

vi.mock("../lib/api", () => ({
  api: { recorder: { assertUrl: vi.fn(async () => ({})) } },
}));
import { api } from "../lib/api";

const popup = vi.fn(async () => ({ commandId: undefined as number | undefined }));
const writeText = vi.fn();

beforeEach(() => {
  popup.mockReset().mockResolvedValue({ commandId: undefined });
  writeText.mockReset();
  vi.mocked(api.recorder.assertUrl).mockClear();
  (window as unknown as { glazeAPI: unknown }).glazeAPI = {
    Menu: { popup },
    clipboard: { writeText },
  };
});

afterEach(() => {
  delete (window as unknown as { glazeAPI?: unknown }).glazeAPI;
});

describe("splitForDisplay", () => {
  it("separates the origin from the part that changes as you browse", () => {
    expect(splitForDisplay("https://ritual.com/products/iron?size=2")).toEqual({
      origin: "https://ritual.com",
      rest: "/products/iron?size=2",
    });
  });

  it("puts an unparseable or non-web URL entirely in `rest`", () => {
    // Rendered rather than dropped: during a failed load or a redirect the bar
    // showing SOMETHING true beats it going blank, which reads as the strip
    // being broken.
    expect(splitForDisplay("about:blank")).toEqual({ origin: "", rest: "about:blank" });
    expect(splitForDisplay("not a url")).toEqual({ origin: "", rest: "not a url" });
    expect(splitForDisplay("")).toEqual({ origin: "", rest: "" });
  });
});

describe("UrlBar", () => {
  it("shows the whole URL, origin and path together", () => {
    // Asserted on the container's text rather than on one node: the two halves
    // are separate spans so the origin can be dimmed, and a test matching only
    // one of them would pass against a bar that had lost the other.
    render(<UrlBar url="https://ritual.com/cart?step=2" loading={false} />);
    expect(screen.getByTestId("training-url").textContent).toBe("https://ritual.com/cart?step=2");
  });

  it("carries the full URL in a title attribute for the truncated case", () => {
    // The bar is one line in a ~36px strip and a real URL routinely overflows
    // it. Truncation with no way to see the rest is the same dead end the user
    // was in before, so the full string stays reachable on hover.
    render(<UrlBar url="https://ritual.com/a/very/long/path/that/will/not/fit" loading={false} />);
    expect(screen.getByTestId("training-url").getAttribute("title")).toBe(
      "https://ritual.com/a/very/long/path/that/will/not/fit",
    );
  });

  it("copies the URL rather than whatever is on screen", () => {
    // The display is split and truncated; the clipboard gets the real string.
    render(<UrlBar url="https://ritual.com/cart" loading={false} />);
    fireEvent.click(screen.getByLabelText("Copy URL"));
    expect(writeText).toHaveBeenCalledWith("https://ritual.com/cart");
  });

  it("opens a URL assertion of the kind the user picked", async () => {
    // commandId 2 is `urlEndsWith` — a middle item. Picking an index off by
    // one would generate a different assertion than the menu promised, and both
    // are plausible-looking lines of Playwright.
    popup.mockResolvedValue({ commandId: 2 });
    render(<UrlBar url="https://ritual.com/cart" loading={false} />);
    fireEvent.click(screen.getByText("Assert URL"));
    await waitFor(() => expect(api.recorder.assertUrl).toHaveBeenCalledWith("urlEndsWith"));
  });

  it("offers 'URL path is' first — the robust default leads the menu", async () => {
    popup.mockResolvedValue({ commandId: 0 });
    render(<UrlBar url="https://ritual.com/cart" loading={false} />);
    fireEvent.click(screen.getByText("Assert URL"));
    await waitFor(() => expect(api.recorder.assertUrl).toHaveBeenCalledWith("urlPathIs"));
  });

  it("does nothing when the menu is dismissed", async () => {
    // A native menu closed with Escape resolves with no commandId. Treating
    // that as index 0 would insert a step the user never asked for.
    popup.mockResolvedValue({ commandId: undefined });
    render(<UrlBar url="https://ritual.com/cart" loading={false} />);
    fireEvent.click(screen.getByText("Assert URL"));
    await waitFor(() => expect(popup).toHaveBeenCalled());
    expect(api.recorder.assertUrl).not.toHaveBeenCalled();
  });

  it("disables both actions before there is a URL to act on", () => {
    // The window is shown before the first load commits. Asserting on an empty
    // URL would generate `toHaveURL("")`, and copying it would silently replace
    // the user's clipboard with nothing.
    render(<UrlBar url="" loading />);
    // `.disabled` rather than a jest-dom matcher: this repo does not install
    // them, and an unknown matcher fails as "Invalid Chai property", which reads
    // like a broken component rather than a missing dependency.
    expect((screen.getByLabelText("Copy URL") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Assert URL") as HTMLButtonElement).disabled).toBe(true);
  });
});
