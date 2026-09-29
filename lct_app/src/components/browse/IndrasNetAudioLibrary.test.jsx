import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(), process: vi.fn(), status: vi.fn(), import: vi.fn(), extract: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => api.navigate }));
vi.mock("../../services/indrasnetAudioApi", () => ({
  listAudioSources: (...args) => api.list(...args),
  processAudioSource: (...args) => api.process(...args),
  getAudioSourceStatus: (...args) => api.status(...args),
  importAudioSource: (...args) => api.import(...args),
  extractImportedTurns: (...args) => api.extract(...args),
}));

import IndrasNetAudioLibrary from "./IndrasNetAudioLibrary";

const ready = {
  source_key: "media:7", source_kind: "media", title: "Synthetic call",
  recorded_at: "2026-09-25T00:00:00Z", duration_seconds: 75,
  status: "ready", can_process: false,
};
let host, root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.values(api).forEach((mock) => mock.mockReset());
  api.list.mockResolvedValue({ sources: [ready], has_more: false });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  vi.useRealTimers();
});

async function mount() {
  await act(async () => root.render(<IndrasNetAudioLibrary />));
}
async function click(text) {
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent.includes(text));
  expect(button).toBeTruthy();
  await act(async () => button.click());
}

it("lists ready metadata and imports turns before extracting graph", async () => {
  api.import.mockResolvedValue({ conversation_id: "synthetic-id", utterance_count: 2 });
  api.extract.mockResolvedValue({ success: true });
  await mount();
  expect(host.textContent).toContain("Synthetic call");
  expect(host.textContent).toContain("Transcript ready");
  await click("Create threads");
  expect(api.import).toHaveBeenCalledWith("media:7", expect.any(Object));
  expect(api.extract).toHaveBeenCalledWith("synthetic-id", expect.any(Object));
  expect(api.navigate).toHaveBeenCalledWith("/conversation/synthetic-id");
});

it("opens already imported threads without replacing or rebuilding them", async () => {
  api.import.mockResolvedValue({ conversation_id: "existing-id", already_imported: true, needs_extraction: false });
  await mount();
  await click("Create threads");
  expect(api.import).toHaveBeenCalledTimes(1);
  expect(api.extract).not.toHaveBeenCalled();
  expect(api.navigate).toHaveBeenCalledWith("/conversation/existing-id");
});

it("builds missing graph structure from an existing import without reimporting turns", async () => {
  api.import.mockResolvedValue({ conversation_id: "existing-id", already_imported: true, needs_extraction: true });
  api.extract.mockResolvedValue({ success: true });
  await mount();
  await click("Create threads");
  expect(api.import).toHaveBeenCalledTimes(1);
  expect(api.extract).toHaveBeenCalledWith("existing-id", expect.any(Object));
  expect(api.navigate).toHaveBeenCalledWith("/conversation/existing-id");
});

it("processes untranscribed audio on request and then offers thread creation", async () => {
  api.list.mockResolvedValue({ sources: [{ ...ready, status: "unprocessed", can_process: true }], has_more: false });
  api.process.mockResolvedValue({ source_key: "media:7", status: "queued", stage: "Queued", can_process: false });
  api.status.mockResolvedValue({ source_key: "media:7", status: "ready", stage: "Complete", can_process: false });
  await mount();
  await click("Process recording");
  expect(api.process).toHaveBeenCalledWith("media:7", expect.any(Object));
  expect(api.status).toHaveBeenCalledWith("media:7", expect.any(Object));
  expect(host.textContent).toContain("Create threads");
  expect(api.import).not.toHaveBeenCalled();
});

it("keeps saved turns and offers extraction retry after a graph failure", async () => {
  api.import.mockResolvedValue({ conversation_id: "synthetic-id", utterance_count: 2 });
  api.extract.mockRejectedValueOnce(new Error("Graph worker unavailable"))
    .mockResolvedValueOnce({ success: true });
  await mount();
  await click("Create threads");
  expect(host.querySelector('[role="status"]').textContent).toContain("Graph worker unavailable");
  await click("Retry building threads");
  expect(api.import).toHaveBeenCalledTimes(1);
  expect(api.extract).toHaveBeenCalledTimes(2);
  expect(api.navigate).toHaveBeenCalledWith("/conversation/synthetic-id");
});

it("reuses the imported conversation when the row action retries graph extraction", async () => {
  api.import.mockResolvedValue({ conversation_id: "synthetic-id", utterance_count: 2 });
  api.extract.mockRejectedValueOnce(new Error("Graph worker unavailable"))
    .mockResolvedValueOnce({ success: true });
  await mount();
  await click("Create threads");
  await click("Create threads");
  expect(api.import).toHaveBeenCalledTimes(1);
  expect(api.extract).toHaveBeenCalledTimes(2);
});

it("stops polling if processing returns an unknown state", async () => {
  api.list.mockResolvedValue({ sources: [{ ...ready, status: "unprocessed", can_process: true }], has_more: false });
  api.process.mockResolvedValue({ source_key: "media:7", status: "unprocessed", can_process: true });
  await mount();
  await click("Process recording");
  expect(host.textContent).toContain("Recording status is unknown");
  expect(api.status).not.toHaveBeenCalled();
});

it("hides the library when the IndraSNet capability is disabled", async () => {
  const disabled = new Error("not configured");
  disabled.status = 503;
  api.list.mockRejectedValue(disabled);
  await mount();
  expect(host.textContent).toBe("");
});

it("shows a retry when the private catalog is unavailable", async () => {
  api.list.mockRejectedValueOnce(new Error("IndraSNet audio library is unreachable."))
    .mockResolvedValueOnce({ sources: [ready], has_more: false });
  await mount();
  expect(host.querySelector('[role="alert"]').textContent).toContain("unreachable");
  await click("Retry loading recordings");
  expect(host.textContent).toContain("Synthetic call");
});
