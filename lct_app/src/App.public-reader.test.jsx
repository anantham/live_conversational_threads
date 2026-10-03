// @vitest-environment jsdom
// Test intent:
// - A public reader route stays free of the account panel and auth requests.
// - Library and private files still expose the real account panel after navigation.
// - Route changes use App's BrowserRouter and its Sites access route matcher.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Link, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("./services/apiClient", () => ({ apiFetch }));
vi.mock("./routes/AppRoutes", () => ({
  default: () => <>
    <nav><Link to="/browse">Library</Link><Link to="/private-files">Private files</Link></nav>
    <Routes>
      <Route path="/view" element={<button type="button">Next moment</button>} />
      <Route path="/view/:artifactId" element={<button type="button">Next moment</button>} />
      <Route path="/public/:publicId" element={<button type="button">Next moment</button>} />
      <Route path="/browse" element={<p>Library content</p>} />
      <Route path="/private-files" element={<p>Private files content</p>} />
    </Routes>
  </>,
}));
vi.mock("./contexts/ByokContext.jsx", () => ({ ByokProvider: ({ children }) => children }));
vi.mock("./contexts/UploadContext", () => ({ UploadProvider: ({ children }) => children }));
vi.mock("./components/upload/UploadToast", () => ({ default: () => null }));

import App from "./App";

let root;
let host;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubEnv("VITE_SITES_MODE", "true");
  localStorage.clear();
  apiFetch.mockReset();
  vi.stubGlobal("fetch", vi.fn((path) => {
    if (path === "/api/auth/session") return Promise.resolve({ status: 401 });
    if (path === "/api/auth/config") return Promise.resolve({ ok: true, json: async () => ({ google: { enabled: false, configured: false } }) });
    throw new Error(`Unexpected request: ${path}`);
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.history.replaceState({}, "", "/");
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each(["/view", "/view/synthetic-artifact", "/public/synthetic-public-id"])(
  "keeps %s usable as a guest, then exposes account controls in Library and private files",
  async (path) => {
    window.history.replaceState({}, "", path);
    await act(async () => root.render(<App />));
    expect(host.querySelector("button")?.textContent).toBe("Next moment");
    expect(host.querySelector("#site-access")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();

    await act(async () => host.querySelector('a[href="/browse"]').click());
    expect(host.textContent).toContain("Library content");
    expect(host.querySelector("#site-access")?.textContent).toContain("Browsing as guest");
    expect(fetch).toHaveBeenCalledWith("/api/auth/session", expect.any(Object));
    expect(fetch).toHaveBeenCalledWith("/api/auth/config", expect.any(Object));

    await act(async () => host.querySelector('a[href="/private-files"]').click());
    expect(host.textContent).toContain("Private files content");
    expect(host.querySelector("#site-access")?.textContent).toContain("Browsing as guest");
    expect(host.querySelector("#site-access")?.classList.contains("fixed")).toBe(false);
    expect(apiFetch).not.toHaveBeenCalled();
  },
);
