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
    // No eyebrow: nothing sits above the title inside the header.
    expect(header.querySelector("h1").previousElementSibling).toBeNull();
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
    await render(<PageHeader embedded title="Public conversations" links={<a href="/x">x</a>} />);
    expect(host.querySelector('nav[aria-label="Page"]')).toBeNull();
    expect(host.querySelector("h1")).toBeNull();
    expect(host.querySelector("h2").textContent).toBe("Public conversations");
  });
});
