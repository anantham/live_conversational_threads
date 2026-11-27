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
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; navigate.mockReset(); vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 }))); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
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

// Critique 2026-11-25 issue 3, owner ruling 2026-11-26: a closed Meet stays visible as "closed for now".
describe("Meet door on Home", () => {
  const meetTile = () => host.querySelector('button[aria-label^="Join Google Meet"], button[aria-label^="Google Meet"]');
  async function renderWith(reply) {
    vi.stubEnv("VITE_SITES_MODE", "true");
    const fetchMock = vi.fn(reply);
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<Home />));
    await act(async () => {});
    return fetchMock;
  }
  it("says closed for now in words, and still opens the page with earlier recordings", async () => {
    const fetchMock = await renderWith(async () => new Response(JSON.stringify({ service: "meetings", enabled: true, available: false, checked_at: 1 })));
    expect(fetchMock).toHaveBeenCalledWith("/api/cloud/health/meetings", expect.objectContaining({ credentials: "same-origin" }));
    expect(meetTile().getAttribute("aria-label")).toBe("Google Meet, closed for now");
    expect(host.textContent).toContain("Closed for now");
    await act(async () => meetTile().click());
    expect(navigate).toHaveBeenCalledWith("/meeting");
  });

  it("looks like any working door when Meet is open", async () => {
    await renderWith(async () => new Response(JSON.stringify({ service: "meetings", enabled: true, available: true, checked_at: 1 })));
    expect(meetTile().getAttribute("aria-label")).toBe("Join Google Meet");
    expect(host.textContent).not.toContain("Closed for now");
  });

  it.each([
    ["a failed check", async () => { throw new TypeError("offline"); }],
    ["an unreadable answer", async () => new Response(JSON.stringify({ service: "soniox", available: false }))],
    // A well-formed "closed" body on an error status: only response.ok keeps this from counting.
    ["a server error", async () => new Response(JSON.stringify({ service: "meetings", enabled: true, available: false, checked_at: 1 }), { status: 503 })],
  ])("does not claim Meet is closed after %s", async (_label, reply) => {
    await renderWith(reply);
    expect(meetTile().getAttribute("aria-label")).toBe("Join Google Meet");
    expect(host.textContent).not.toContain("Closed for now");
  });
});
