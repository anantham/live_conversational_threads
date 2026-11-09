// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_LIMITS } from "../../sites/storagePolicy.js";
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
    expect(container.textContent).toContain("Private saving requires sign-in");
    expect(container.textContent).toContain(`${STORAGE_LIMITS.maxFileBytes / 1048576} MiB, with ${STORAGE_LIMITS.maxOwnerBytes / 1048576} MiB per account and ${STORAGE_LIMITS.maxSiteBytes / 1048576} MiB shared`);
    expect(container.textContent).toContain("downloaded by anyone");
    expect(container.textContent).toContain("Google Gemini through Google AI Studio");
    expect(container.textContent).toContain("does not automatically switch providers or retry");
    expect(container.textContent).toContain("does not store the Google identity token");
    expect(container.querySelector('a[href="mailto:aditya@repub.live"]')).not.toBeNull();
  });

  it("routes a direct /privacy visit in Sites mode without a session provider", async () => {
    vi.stubEnv("VITE_SITES_MODE", "true");
    await act(async () => root.render(<MemoryRouter initialEntries={["/privacy"]}><AppRoutes /></MemoryRouter>));
    expect(container.querySelector("h1")?.textContent).toBe("Privacy at Threads");
  });
});
