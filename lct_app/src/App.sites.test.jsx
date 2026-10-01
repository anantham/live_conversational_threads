// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch, providerKeys } = vi.hoisted(() => ({ apiFetch: vi.fn(), providerKeys: [] }));
vi.mock("./services/apiClient", () => ({ apiFetch }));
vi.mock("./services/ServerlessDataProvider", () => ({
  ServerlessDataProvider: class { constructor(key) { providerKeys.push(key); this.isServerless = true; } },
}));
vi.mock("./routes/AppRoutes", () => ({ default: () => <div>Public route</div> }));
vi.mock("./contexts/ByokContext.jsx", () => ({ ByokProvider: ({ children }) => children }));
vi.mock("./contexts/UploadContext", () => ({ UploadProvider: ({ children }) => children }));
vi.mock("./components/upload/UploadToast", () => ({ default: () => null }));

import App from "./App";

let root;
let container;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubEnv("VITE_SITES_MODE", "true");
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  apiFetch.mockReset();
  providerKeys.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Sites public shell", () => {
  it("renders immediately with keyless browser-local data and no legacy backend health request", async () => {
    const readStorage = vi.spyOn(Storage.prototype, "getItem");
    await act(async () => root.render(<App />));
    expect(container.textContent).toContain("Public route");
    expect(container.textContent).toContain("Checking sign-in");
    expect(container.textContent).not.toContain("Enter your API key");
    expect(providerKeys).toContain("");
    expect(apiFetch).not.toHaveBeenCalled();
    expect(readStorage).not.toHaveBeenCalledWith("lct_serverless_key");
    expect(readStorage).not.toHaveBeenCalledWith("lct_serverless_mode_enabled");
    expect(fetch).toHaveBeenCalledWith("/api/auth/session", expect.any(Object));
    readStorage.mockRestore();
  });
});
