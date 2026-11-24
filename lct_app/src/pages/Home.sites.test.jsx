// @vitest-environment jsdom
// Intent: tests/intent/sites-public-threads.md. Public collection is the default cloud Browse target.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));
vi.mock("../services/localDraftStore", () => ({ loadLatestDraft: async () => null, summarizeLocalDraft: () => null }));
vi.mock("../components/ServiceStatus", () => ({ default: () => <span>Legacy service status</span> }));
import Home from "./Home";
let root, host;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; navigate.mockReset(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllEnvs(); });
describe("Home in Sites mode", () => {
  it("omits the private backend service status while retaining public browse", async () => {
    vi.stubEnv("VITE_SITES_MODE", "true");
    await act(async () => root.render(<Home />));
    expect(host.querySelector('button[aria-label="Browse library"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Legacy service status");
  });
});
for (const sites of [true, false]) it(`opens the appropriate Browse destination (Sites=${sites})`, async () => {
  vi.stubEnv("VITE_SITES_MODE", String(sites));
  await act(async () => root.render(<Home />));
  await act(async () => [...host.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === "Browse library").click());
  expect(navigate).toHaveBeenCalledWith("/browse");
});

// UX review 2026-11-05: the Site shows no door that does nothing, and every working door is drawn alike.
for (const sites of [true, false]) it(`shows Bookmarks only where it is a pending placeholder (Sites=${sites})`, async () => {
  vi.stubEnv("VITE_SITES_MODE", String(sites));
  await act(async () => root.render(<Home />));
  const labels = [...host.querySelectorAll("button")].map(button => button.getAttribute("aria-label"));
  expect(labels.includes("Bookmarks")).toBe(!sites);
  expect(labels.includes("Import transcript")).toBe(sites);
  expect(labels.includes("Private files")).toBe(false);
  expect(labels).toEqual(expect.arrayContaining(["Import audio", "Costs", "Settings"]));
});

it("shows the icon label on keyboard focus and dismisses it with Escape", async () => {
  vi.stubEnv("VITE_SITES_MODE", "true");
  await act(async () => root.render(<Home />));
  const importTranscript = host.querySelector('button[aria-label="Import transcript"]');
  expect(importTranscript.textContent).toBe("");
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => importTranscript.focus());
  expect(document.querySelector('[role="tooltip"]').textContent).toBe("Import transcript");
  await act(async () => importTranscript.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => importTranscript.click());
  expect(navigate).toHaveBeenCalledWith("/import-transcript");
});
