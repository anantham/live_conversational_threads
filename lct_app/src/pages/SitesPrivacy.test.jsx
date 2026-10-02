// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SitesPrivacy from "./SitesPrivacy";
import AppRoutes from "../routes/AppRoutes";

let root;
let container;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllEnvs();
});

describe("Sites privacy disclosure", () => {
  it("gives a guest the private/public distinction, Google identity scope, and contact", async () => {
    await act(async () => root.render(<MemoryRouter><SitesPrivacy /></MemoryRouter>));
    expect(container.querySelector("h1")?.textContent).toBe("Privacy at Threads");
    expect(container.textContent).toContain("Opening a browser-local file does not upload or publish it automatically.");
    expect(container.textContent).toContain("synthetic checks for private uploads");
    expect(container.textContent).toContain("downloaded by anyone");
    expect(container.textContent).toContain("does not store the Google identity token");
    expect(container.querySelector('a[href="mailto:aditya@repub.live"]')).not.toBeNull();
  });

  it("routes a direct /privacy visit in Sites mode without a session provider", async () => {
    vi.stubEnv("VITE_SITES_MODE", "true");
    await act(async () => root.render(<MemoryRouter initialEntries={["/privacy"]}><AppRoutes /></MemoryRouter>));
    expect(container.querySelector("h1")?.textContent).toBe("Privacy at Threads");
  });
});
