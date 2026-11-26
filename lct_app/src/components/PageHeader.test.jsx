// @vitest-environment jsdom
// Intent: see PageHeader.jsx. One page header for every standalone page (critique 2026-11-25 issue 5).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PageHeader from "./PageHeader";

let root, host;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = (ui) => act(async () => root.render(<MemoryRouter>{ui}</MemoryRouter>));

describe("PageHeader", () => {
  it("opens a standalone page with a way home, page links, one h1, its description and actions", async () => {
    await render(<PageHeader title="Private cloud files" description="Files here belong to your account."
      links={<a href="/browse">Library</a>} actions={<button type="button">Upload</button>} />);
    const back = host.querySelector('nav[aria-label="Page"] a[href="/"]');
    expect(back.textContent).toBe("Home");
    expect(host.querySelector('nav[aria-label="Page"] a[href="/browse"]').textContent).toBe("Library");
    expect([...host.querySelectorAll("h1")].map((h) => h.textContent)).toEqual(["Private cloud files"]);
    const header = host.querySelector("[data-page-header]");
    expect(header.textContent).toContain("Files here belong to your account.");
    expect(header.querySelector("button").textContent).toBe("Upload");
    // No eyebrow: the title comes first, at every depth from the header block down to the h1.
    let node = header.querySelector("h1");
    while (node !== header) { expect(node.previousElementSibling).toBeNull(); node = node.parentElement; }
    expect(header.textContent.startsWith("Private cloud files")).toBe(true);
    // One page's title, not a site-wide banner landmark.
    expect(host.querySelector("header")).toBeNull();
  });

  it("refuses a way back with nowhere to go", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await render(<PageHeader title="Lost" back={{ label: "Back" }} />);
      expect(error.mock.calls.flat().join(" ")).toContain('needs a "to" destination or an onClick handler');
      error.mockClear();
      // A valid destination does not excuse a broken handler, and the link is used instead of it.
      await render(<PageHeader title="Odd" back={{ label: "Back", to: "/", onClick: "oops" }} />);
      expect(error.mock.calls.flat().join(" ")).toContain("onClick must be a function");
      expect(host.querySelector('nav[aria-label="Page"] a[href="/"]')).toBeTruthy();
    } finally { error.mockRestore(); }
  });

  it("can go back through history instead of a link", async () => {
    const onClick = vi.fn();
    await render(<PageHeader title="Settings" back={{ onClick, label: "Back" }} />);
    const back = host.querySelector('nav[aria-label="Page"] button');
    expect(back.textContent).toBe("Back");
    await act(async () => back.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("inside another page, drops the way back and yields the h1 to its host", async () => {
    await render(<PageHeader embedded title="Public conversations" />);
    expect(host.querySelector('nav[aria-label="Page"]')).toBeNull();
    expect(host.querySelector("h1")).toBeNull();
    expect(host.querySelector("h2").textContent).toBe("Public conversations");
  });

  it("inside another page, keeps links the caller still passes", async () => {
    await render(<PageHeader embedded title="Public conversations" links={<a href="/x">Only here</a>} />);
    // Named for its own section, so it never repeats the host page's "Page" landmark.
    expect(host.querySelector('nav[aria-label="Page"]')).toBeNull();
    expect(host.querySelector('nav[aria-label="Public conversations links"] a[href="/x"]').textContent).toBe("Only here");
    expect(host.querySelector('a[href="/"]')).toBeNull();
  });
});
