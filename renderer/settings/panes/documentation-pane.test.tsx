// Tests for the Documentation pane.
//
// The pane renders a document nobody edits here, so the interesting assertions
// are not about the words. They are about the four ways this can fail SILENTLY
// — each of which leaves a pane that renders fine and tells the user nothing:
//
//   • A deep link lands on the wrong topic (or on the first one), so every Help
//     menu item appears to do the same thing.
//   • A block kind stops rendering. A table or a code fence that draws nothing
//     leaves the surrounding prose intact and looks deliberate.
//   • The copy button copies the wrong thing, or offers a command for a server
//     that is not there — the one claim in this pane about the user's machine.
//   • A command block loses its copy button. The block still renders, the words
//     are still right, and the only way out of the app is retyping — which is
//     what this pane looked like until the button existed. The OTHER half of
//     that fix, `user-select: text`, cannot be asserted here at all (the dom
//     project runs with `css: false`); `check:docs-copyable` holds that end.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";

import { renderPane } from "../__tests__/harness";
import { DocumentationPane } from "./documentation-pane";
import { MCP_GUIDE, docRowId } from "../../lib/docs";
import { REQUIRED_TOPIC_SLUGS } from "../../lib/doc-blocks";

const mcpServer = vi.fn(async () => ({
  path: "/repo/mcp/server.mjs",
  exists: true,
  command: 'claude mcp add --scope user good-looks -- node "/repo/mcp/server.mjs"',
}));

vi.mock("../../lib/api", () => ({
  api: { docs: { mcpServer: () => mcpServer() } },
}));

const writeText = vi.fn();
const openExternal = vi.fn();

function setHash(hash: string) {
  window.location.hash = hash;
}

beforeEach(() => {
  setHash("");
  mcpServer.mockClear();
  writeText.mockClear();
  openExternal.mockClear();
  (window as unknown as { glazeAPI: unknown }).glazeAPI = {
    clipboard: { writeText },
    shell: { openExternal },
  };
});

afterEach(() => {
  setHash("");
});

/**
 * Which icon a button is showing. Every lucide icon ships a `lucide-<kebab>`
 * class, which is the only thing in the DOM that distinguishes the tick from
 * the clipboard — same reader as `recording-view.test.tsx`.
 */
function iconOf(button: HTMLElement): string {
  const svg = button.querySelector("svg");
  if (!svg) throw new Error("no icon in the button");
  const cls = [...svg.classList].find((c) => c.startsWith("lucide-") && c !== "lucide-icon");
  if (!cls) throw new Error(`no lucide class on ${svg.outerHTML.slice(0, 80)}`);
  return cls.replace(/^lucide-/, "");
}

function titleOf(slug: string): string {
  const topic = MCP_GUIDE.topics.filter((t) => t.slug === slug)[0];
  if (!topic) throw new Error(`no topic ${slug} — the guide's headings changed`);
  return topic.title;
}

describe("topics", () => {
  it("offers every topic in the guide", () => {
    renderPane(<DocumentationPane />);
    for (const topic of MCP_GUIDE.topics) {
      expect(screen.getByRole("button", { name: topic.title })).toBeTruthy();
    }
  });

  it("opens on the first topic when nothing asked for one", () => {
    renderPane(<DocumentationPane />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      MCP_GUIDE.topics[0].title,
    );
  });

  it("opens on the topic a deep link names", () => {
    // The whole point of the Help menu. Landing on the first topic instead
    // would make every menu item look identical.
    setHash("#documentation/troubleshooting");
    renderPane(<DocumentationPane />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      titleOf("troubleshooting"),
    );
  });

  it("falls back to the first topic when the slug is unknown", () => {
    setHash("#documentation/no-such-section");
    renderPane(<DocumentationPane />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      MCP_GUIDE.topics[0].title,
    );
  });

  it("switches topic on click", () => {
    renderPane(<DocumentationPane />);
    fireEvent.click(screen.getByRole("button", { name: titleOf("setup") }));
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(titleOf("setup"));
  });

  it("marks the open topic as current", () => {
    setHash("#documentation/setup");
    renderPane(<DocumentationPane />);
    expect(
      screen.getByRole("button", { name: titleOf("setup") }).getAttribute("aria-current"),
    ).toBe("true");
  });

  it("every topic the Help menu links to is reachable here", () => {
    // Guarded at the source level by `check:docs-blocks` too. This is the same
    // fact from the pane's side: a slug in the menu that this list cannot show
    // is a menu item that opens the wrong page.
    renderPane(<DocumentationPane />);
    for (const slug of REQUIRED_TOPIC_SLUGS) {
      expect(screen.getByRole("button", { name: titleOf(slug) })).toBeTruthy();
    }
  });
});

describe("search", () => {
  it("shows only the topics a search matched", () => {
    const only = docRowId("troubleshooting");
    renderPane(<DocumentationPane />, { matchedIds: [only] });
    expect(screen.getByRole("button", { name: titleOf("troubleshooting") })).toBeTruthy();
    expect(screen.queryByRole("button", { name: titleOf("setup") })).toBeNull();
  });

  it("opens a matched topic when the search filtered the open one away", () => {
    // Otherwise the rail advertises one topic while the body still shows
    // another — which reads as broken search rather than a narrowed list.
    setHash("#documentation/setup");
    renderPane(<DocumentationPane />, { matchedIds: [docRowId("troubleshooting")] });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      titleOf("troubleshooting"),
    );
  });
});

describe("rendering the document", () => {
  it("draws a table with its rows, not just its header", () => {
    // Wait for content, not the container: a table element renders whether or
    // not any cell did.
    setHash("#documentation/troubleshooting");
    renderPane(<DocumentationPane />);
    const table = screen.getAllByRole("table")[0];
    expect(within(table).getAllByRole("row").length).toBeGreaterThan(2);
  });

  it("draws code blocks", () => {
    setHash("#documentation/setup");
    const { container } = renderPane(<DocumentationPane />);
    const blocks = [...container.querySelectorAll("pre.gl-doc-pre")];
    expect(blocks.length).toBeGreaterThan(0);
    // ANY block, not `blocks[0]`. The subject here is that fenced code renders
    // at all; which block comes first is the document's business, and pinning
    // the index made an ordinary edit to MCP-GUIDE.md §2 fail a test about the
    // parser. What matters is that the register command survives the round trip
    // into the pane — it is the one line on this page a user has to copy.
    expect(blocks.some((b) => b.textContent?.includes("claude mcp add"))).toBe(true);
  });

  it("renders bold and inline code as their own elements", () => {
    const { container } = renderPane(<DocumentationPane />);
    expect(container.querySelector("strong.gl-doc-strong")).toBeTruthy();
    expect(container.querySelector("code.gl-doc-code")).toBeTruthy();
  });

  it("does not draw a link the app cannot open", () => {
    // The guide links relative repo paths. `shell.openExternal` accepts https
    // on github.com and nothing else, so an underlined relative link would be a
    // control that does nothing — worse than plain text.
    setHash("#documentation/see-also");
    const { container } = renderPane(<DocumentationPane />);
    expect(container.querySelector(".gl-doc-link")).toBeNull();
    expect(container.textContent).toContain("mcp/README.md");
  });
});

describe("the MCP server on this machine", () => {
  it("offers the resolved command, and copies exactly that", async () => {
    setHash("#documentation/setup");
    renderPane(<DocumentationPane />);
    const button = await screen.findByRole("button", { name: /copy command/i });
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith(
      'claude mcp add --scope user good-looks -- node "/repo/mcp/server.mjs"',
    );
  });

  it("says the server is not here rather than offering a command that names nothing", async () => {
    // NO LONGER THE PACKAGED CASE. R15 ships `mcp/**`, so a `.app` takes the
    // branch above; what is left here is a source tree without the folder, and
    // a `build.files` regression. The branch is kept for exactly that second
    // reason — it is what turns a packaging mistake into a message instead of a
    // command that names nothing.
    mcpServer.mockResolvedValueOnce({ path: "/app/mcp/server.mjs", exists: false, command: "" });
    setHash("#documentation/setup");
    renderPane(<DocumentationPane />);
    await waitFor(() => {
      expect(screen.getByText(/not where this copy of the app expects it/i)).toBeTruthy();
    });
    // It names the path it looked at, so the reader can see WHICH assumption
    // broke rather than being told the file is missing from somewhere unstated.
    expect(screen.getByText("/app/mcp/server.mjs")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /copy command/i })).toBeNull();
  });

  it("shows nothing extra on other topics", () => {
    setHash("#documentation/troubleshooting");
    renderPane(<DocumentationPane />);
    expect(screen.queryByRole("button", { name: /copy command/i })).toBeNull();
  });
});

describe("copying a command", () => {
  /** The `<pre>`s of the open topic, each with the button that copies it. */
  function blocks(container: HTMLElement) {
    return [...container.querySelectorAll<HTMLElement>(".gl-doc-codeblock")].map((wrap) => ({
      text: wrap.querySelector("pre")?.textContent ?? "",
      button: wrap.querySelector("button"),
    }));
  }

  it("gives every command block a copy button", () => {
    // EVERY block, not "a copy button exists somewhere on the page". The pane
    // shipped with one — on the machine-specific card — which is exactly the
    // state this test describes as broken: the reader learns that a block
    // without a button is one to retype.
    setHash("#documentation/setup");
    const { container } = renderPane(<DocumentationPane />);
    const found = blocks(container);
    expect(found.length).toBeGreaterThan(0);
    expect(container.querySelectorAll("pre.gl-doc-pre").length).toBe(found.length);
    for (const block of found) expect(block.button).toBeTruthy();
  });

  it("copies the block it sits on, exactly", () => {
    // The failure this rules out is the one a screenshot cannot: a button that
    // copies the first block on the page whichever one you pressed.
    setHash("#documentation/setup");
    const { container } = renderPane(<DocumentationPane />);
    const found = blocks(container);
    const last = found[found.length - 1];
    fireEvent.click(last.button as HTMLElement);
    expect(writeText).toHaveBeenCalledWith(last.text);
    expect(last.text.length).toBeGreaterThan(0);
  });

  it("acknowledges the copy", () => {
    // Writing to the clipboard is invisible. Without the tick the only way to
    // know the press landed is to paste somewhere and look.
    setHash("#documentation/setup");
    const { container } = renderPane(<DocumentationPane />);
    const button = blocks(container)[0].button as HTMLElement;
    expect(iconOf(button)).toBe("copy");
    fireEvent.click(button);
    expect(iconOf(button)).toBe("check");
  });

  it("copies the resolved command from the card's own block", async () => {
    // Same control as every other block — only the name differs, because this
    // is the one command that is about the reader's machine.
    setHash("#documentation/setup");
    const { container } = renderPane(<DocumentationPane />);
    const button = await screen.findByRole("button", { name: /copy command/i });
    expect(button.closest(".gl-doc-codeblock")).toBeTruthy();
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith(
      'claude mcp add --scope user good-looks -- node "/repo/mcp/server.mjs"',
    );
    expect(container.querySelectorAll(".gl-doc-card button").length).toBe(1);
  });
});
