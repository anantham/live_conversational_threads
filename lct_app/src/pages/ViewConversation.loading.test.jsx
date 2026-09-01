import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Test intent:
 * - the required conversation graph becomes usable before optional metadata resolves;
 * - audio status and list metadata start concurrently after primary hydration;
 * - the latency repair preserves the newer explicit semantic-edge input.
 */

const apiFetchCachedMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const fetchRevisionsMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({
  useParams: () => ({ conversationId: "conversation-123" }),
  useNavigate: () => navigateMock,
}));

vi.mock("../components/MinimalGraph", () => ({
  default: ({ semanticEdges }) => (
    <div data-testid="minimal-graph" data-edge-count={semanticEdges?.length ?? 0} />
  ),
}));
vi.mock("../components/MinimalLegend", () => ({ default: () => null }));
vi.mock("../components/NodeDetail", () => ({ default: () => null }));
vi.mock("../components/SearchDialog", () => ({ default: () => null }));
vi.mock("../components/TimelineRibbon", () => ({ default: () => null }));
vi.mock("../components/AnalyzeMenu", () => ({ default: () => null }));
vi.mock("../components/share/ShareManagerModal", () => ({ default: () => null }));
vi.mock("../components/audio/exportSessionDebug", () => ({
  buildConversationDebugExport: vi.fn(),
  downloadConversationDebugExport: vi.fn(),
}));
vi.mock("../services/conversationDiagnosticsApi", () => ({
  fetchConversationObservability: vi.fn(async () => ({})),
}));
vi.mock("../components/graphConstants", () => ({
  buildSpeakerColorMap: () => new Map(),
}));
vi.mock("../services/apiClient", () => ({
  apiFetch: vi.fn(),
  apiFetchCached: (...args) => apiFetchCachedMock(...args),
  apiHeaders: () => ({}),
  API_BASE_URL: "",
  invalidateApiCache: vi.fn(),
  readErrorMessage: vi.fn(async () => "request failed"),
}));
vi.mock("../services/dataProvider", () => ({
  useDataProvider: () => ({
    conversations: {
      fetchRevisions: (...args) => fetchRevisionsMock(...args),
      approveRevision: vi.fn(),
      rejectRevision: vi.fn(),
      fetchNext: vi.fn(),
      reprocess: vi.fn(),
      fetchThreadsExport: vi.fn(),
    },
  }),
}));
vi.mock("../services/participantsApi", () => ({
  fetchConversationParticipants: vi.fn(async () => []),
}));

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ViewConversation progressive loading", () => {
  let container;
  let root;
  let originalActEnvironment;

  beforeEach(() => {
    apiFetchCachedMock.mockReset();
    navigateMock.mockReset();
    fetchRevisionsMock.mockReset();
    fetchRevisionsMock.mockResolvedValue({
      ok: true,
      json: async () => ({ revisions: [] }),
    });
    originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  });

  it("renders the graph while independent supplemental requests are still pending", async () => {
    const audioStatus = deferred();
    const conversationList = deferred();
    apiFetchCachedMock.mockImplementation((path) => {
      if (path === "/conversations/conversation-123") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            graph_data: [[{ id: "node-1", node_name: "First idea" }]],
            edges: [{ from_node_id: "node-1", to_node_id: "node-1", relation_type: "contextual" }],
            chunk_dict: {},
          }),
        });
      }
      if (path === "/api/conversations/conversation-123/audio/status") {
        return audioStatus.promise;
      }
      if (path === "/conversations/") {
        return conversationList.promise;
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const { default: ViewConversation } = await import("./ViewConversation");
    await act(async () => {
      root = createRoot(container);
      root.render(<ViewConversation />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const graph = container.querySelector('[data-testid="minimal-graph"]');
    expect(graph).not.toBeNull();
    expect(graph.getAttribute("data-edge-count")).toBe("1");
    expect(container.textContent).not.toContain("Loading conversation...");
    expect(apiFetchCachedMock).toHaveBeenCalledWith(
      "/api/conversations/conversation-123/audio/status",
      { ttlMs: 5 * 60 * 1000 },
    );
    expect(apiFetchCachedMock).toHaveBeenCalledWith(
      "/conversations/",
      { ttlMs: 60 * 1000 },
    );

    await act(async () => {
      audioStatus.resolve({ ok: true, json: async () => ({}) });
      conversationList.resolve({ ok: true, json: async () => [] });
      await Promise.resolve();
    });
  });
});
