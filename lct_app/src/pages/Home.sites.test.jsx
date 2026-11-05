// @vitest-environment jsdom
// Intent: tests/intent/sites-public-threads.md. Public collection is the default cloud Browse target.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
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
  it("omits the private backend service status while retaining public browse", () => {
    vi.stubEnv("VITE_SITES_MODE", "true");
    try {
      const html = renderToStaticMarkup(<Home />);
      expect(html).toContain("Browse");
      expect(html).not.toContain("Legacy service status");
    } finally { vi.unstubAllEnvs(); }
  });
});
for (const sites of [true, false]) it(`opens the appropriate Browse destination (Sites=${sites})`, async () => {
  vi.stubEnv("VITE_SITES_MODE", String(sites));
  await act(async () => root.render(<Home />));
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Browse").click());
  expect(navigate).toHaveBeenCalledWith(sites ? "/public" : "/browse");
});
