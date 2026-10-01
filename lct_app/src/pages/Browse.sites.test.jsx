// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listSaved, apiFetch, navigate, listLocal, loadDraft } = vi.hoisted(() => ({
  listSaved: vi.fn(), apiFetch: vi.fn(), navigate: vi.fn(), listLocal: vi.fn(), loadDraft: vi.fn(),
}));
const provider = { conversations: { listSaved } };
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));
vi.mock("../services/dataProvider", () => ({ useDataProvider: () => provider }));
vi.mock("../services/apiClient", () => ({ apiFetch, API_BASE_URL: "https://owner.example" }));
vi.mock("../components/browse/IndrasNetAudioLibrary", () => ({ default: () => <div>Owner audio library</div> }));
vi.mock("../components/threads/ThreadsFileButton", () => ({ default: () => <button type="button">Open .threads file</button> }));
vi.mock("../hooks/useThreadsFileDrop", () => ({ useThreadsFileDrop: () => ({ isDraggingFile: false, dropTargetProps: {} }) }));
vi.mock("../services/threadsLibraryStore", () => ({
  listThreadsLibraryRecords: listLocal,
  removeThreadsLibraryRecord: vi.fn(),
}));
vi.mock("../services/localDraftStore", () => ({
  loadLatestDraft: loadDraft,
  summarizeLocalDraft: () => ({ title: "Device draft", nodeCount: 2 }),
}));

import Browse from "./Browse";

let root;
let container;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  listSaved.mockReset();
  apiFetch.mockReset();
  navigate.mockReset();
  listLocal.mockReset().mockResolvedValue([{
    id: "artifact-1", title: "Local file", lastOpenedAt: "2026-10-01T00:00:00Z", nodeCount: 2, sourceName: "test.threads",
  }]);
  loadDraft.mockReset().mockResolvedValue({ id: "draft-1" });
  listSaved.mockResolvedValue({ json: async () => ({ items: [] }) });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllEnvs();
});

async function renderBrowse() {
  await act(async () => root.render(<Browse />));
}

describe("Browse Sites access", () => {
  it("keeps browser-local file and draft controls without mounting owner audio or server history", async () => {
    vi.stubEnv("VITE_SITES_MODE", "true");
    await renderBrowse();
    expect(container.textContent).toContain("Open .threads file");
    expect(container.textContent).toContain("Local file");
    expect(container.textContent).toContain("Device draft");
    expect(container.textContent).toContain("Files opened here stay in this browser.");
    expect(container.textContent).not.toContain("Owner audio library");
    expect(container.textContent).not.toContain("Server history");
    expect(container.textContent).not.toContain("Start a live recording");
    expect(listSaved).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent.includes("Local file")).click());
    expect(navigate).toHaveBeenCalledWith("/view/artifact-1");
  });

  it("retains owner audio and server history outside Sites mode", async () => {
    vi.stubEnv("VITE_SITES_MODE", "false");
    await renderBrowse();
    expect(container.textContent).toContain("Owner audio library");
    expect(container.textContent).toContain("Server history");
    expect(listSaved).toHaveBeenCalledTimes(1);
  });
});
